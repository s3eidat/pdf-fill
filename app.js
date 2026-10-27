/* PDF Form Filler — fields read and written by pdf-lib (MIT), preview by pdf.js (Mozilla, Apache-2.0). Everything runs in this tab. */
import * as pdfjsLib from "./lib/pdf.min.mjs";
pdfjsLib.GlobalWorkerOptions.workerSrc = "lib/pdf.worker.min.mjs";

const { $, $$, h } = S3;
const { PDFDocument, StandardFonts, PDFName, PDFBool, PDFTextField, PDFCheckBox, PDFRadioGroup, PDFDropdown, PDFOptionList, PDFSignature, rgb } = PDFLib;

// ---------- model (pure, testable) ----------
async function loadLib(bytes) {
  try { return await PDFDocument.load(bytes, { updateMetadata: false }); }
  catch (e) { throw new Error(/encrypted/i.test(e && e.message) ? "This PDF is password-protected or encrypted. Remove the protection first." : "This file couldn't be read as a PDF."); }
}
function openJs(bytes) { return pdfjsLib.getDocument({ data: bytes.slice(), isEvalSupported: false, verbosity: 0 }).promise; }
function kindOf(f) {
  if (f instanceof PDFTextField) return "text";
  if (f instanceof PDFCheckBox) return "check";
  if (f instanceof PDFRadioGroup) return "radio";
  if (f instanceof PDFDropdown) return "dropdown";
  if (f instanceof PDFOptionList) return "list";
  if (f instanceof PDFSignature) return "signature";
  return "button";
}
const safe = (fn, d) => { try { const v = fn(); return v === undefined ? d : v; } catch (e) { return d; } };
function humanize(name) {
  const last = String(name).split(".").pop().replace(/\[\d+\]$/, "");
  const words = last.replace(/[_-]+/g, " ").replace(/([a-z])([A-Z])/g, "$1 $2").split(/\s+/).filter(Boolean).map(w => /^[A-Z0-9]{2,}$/.test(w) ? w : w.toLowerCase());
  return words.join(" ").replace(/^./, c => c.toUpperCase()) || name;
}
function readValue(f, kind) {
  if (kind === "text") return safe(() => f.getText(), "") || "";
  if (kind === "check") return safe(() => f.isChecked(), false);
  if (kind === "radio") return safe(() => f.getSelected(), "") || "";
  if (kind === "dropdown" || kind === "list") return safe(() => f.getSelected(), []) || [];
  return null;
}
function analyse(doc) {
  const form = doc.getForm(), pages = doc.getPages(), out = [];
  form.getFields().forEach(f => {
    const kind = kindOf(f), name = f.getName(), ws = safe(() => f.acroField.getWidgets(), []);
    const options = ["radio", "dropdown", "list"].includes(kind) ? safe(() => f.getOptions(), []) : [];
    const rects = ws.map((w, i) => {
      const pg = safe(() => pages.indexOf(form.findWidgetPage(w)), -1), r = safe(() => w.getRectangle(), { x: 0, y: 0, width: 0, height: 0 });
      let opt = null;
      if (kind === "radio") opt = options.length === ws.length ? options[i] : safe(() => w.getOnValue().decodeText(), null);
      return { page: pg, x: r.x, y: r.y, w: r.width, h: r.height, opt };
    });
    const onPages = rects.filter(r => r.page >= 0), page = onPages.length ? Math.min(...onPages.map(r => r.page)) : -1, first = onPages.find(r => r.page === page) || rects[0];
    const tu = safe(() => f.acroField.dict.lookup(PDFName.of("TU")).decodeText(), "");
    const orig = readValue(f, kind);
    out.push({
      name, kind, page, rects, options, orig, label: tu || humanize(name), tip: tu ? name : "",
      fillable: !["button", "signature"].includes(kind) && !safe(() => f.isReadOnly(), false),
      readOnly: safe(() => f.isReadOnly(), false), required: safe(() => f.isRequired(), false),
      multiline: kind === "text" && safe(() => f.isMultiline(), false), maxLen: kind === "text" ? safe(() => f.getMaxLength(), undefined) : undefined,
      editable: kind === "dropdown" && safe(() => f.isEditable(), false), multi: (kind === "dropdown" || kind === "list") && safe(() => f.isMultiselect(), false),
      sortY: first ? -(first.y + first.h) : 0, sortX: first ? first.x : 0
    });
  });
  out.sort((a, b) => (a.page < 0 ? 1e9 : a.page) - (b.page < 0 ? 1e9 : b.page) || Math.round(a.sortY / 4) - Math.round(b.sortY / 4) || a.sortX - b.sortX);
  return out;
}
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const isEmpty = v => v == null || v === "" || v === false || (Array.isArray(v) && !v.length);

// vals: Map(name -> value). Only changed fields get new appearances, so untouched ones keep the file's own look.
async function fill(bytes, fields, vals, opts) {
  opts = opts || {};
  const doc = await loadLib(bytes), form = doc.getForm(), font = await doc.embedFont(StandardFonts.Helvetica), noAp = [];
  if (safe(() => form.hasXFA(), false)) form.deleteXFA();
  for (const fd of fields) {
    if (!fd.fillable) continue;
    const v = vals.has(fd.name) ? vals.get(fd.name) : fd.orig, changed = !same(v, fd.orig);
    let f; try { f = form.getField(fd.name); } catch (e) { continue; }
    const noAppearance = () => safe(() => f.acroField.getWidgets().some(w => { const ap = w.getAppearances(); return !ap || !ap.normal; }), false);
    if (!changed && !(opts.flatten && noAppearance())) continue;
    if (changed) {
      if (fd.kind === "text") f.setText(v ? String(v) : undefined);
      else if (fd.kind === "check") { if (v) f.check(); else f.uncheck(); }
      else if (fd.kind === "radio") { if (v) f.select(v); else f.clear(); }
      else if (fd.kind === "dropdown") { if (!v.length) f.clear(); else f.select(fd.multi ? v : v[0]); }
      else if (fd.kind === "list") { if (!v.length) f.clear(); else f.select(v); }
    }
    try { if (["text", "dropdown", "list"].includes(fd.kind)) f.updateAppearances(font); else f.updateAppearances(); }
    catch (e) { noAp.push(fd.label); }
  }
  if (noAp.length && opts.flatten) throw new Error("Can't flatten: " + noAp.join(", ") + (noAp.length > 1 ? " contain" : " contains") + " characters the standard PDF font can't draw (Arabic, for example). Untick Flatten to keep the form fillable; most viewers will then show the text.");
  if (noAp.length) form.acroForm.dict.set(PDFName.of("NeedAppearances"), PDFBool.True);
  if (opts.flatten) form.flatten({ updateFieldAppearances: false });
  return { bytes: await doc.save({ updateFieldAppearances: false }), noAp };
}

// ---------- UI ----------
const st = { file: null, base: "", bytes: null, js: null, fields: [], vals: new Map(), page: 0, vps: [], hot: null, dirty: false, saved: false };
const fieldEl = name => $$(".pf-field").find(e => e.dataset.name === name);
const fd = name => st.fields.find(x => x.name === name);

function setVal(name, v) {
  st.vals.set(name, v); st.dirty = true; st.saved = false;
  $$(".pf-box").filter(b => b.dataset.name === name).forEach(paintBox);
  counts();
}
function counts() {
  const f = st.fields.filter(x => x.fillable), filled = f.filter(x => !isEmpty(st.vals.get(x.name))).length;
  $("#count").textContent = st.fields.length + " fields · " + filled + " filled";
}
function inputFor(d) {
  const v = st.vals.get(d.name), id = "f" + st.fields.indexOf(d), dis = !d.fillable;
  if (d.kind === "text") {
    const el = h(d.multiline ? "textarea" : "input", { "class": d.multiline ? "textarea" : "input", id, dir: "auto", spellcheck: "false", disabled: dis, maxlength: d.maxLen || null, "aria-required": d.required ? "true" : null });
    el.value = v || "";
    el.addEventListener("input", () => setVal(d.name, el.value));
    return el;
  }
  if (d.kind === "check") {
    const cb = h("input", { type: "checkbox", id, disabled: dis }); cb.checked = !!v;
    cb.addEventListener("change", () => setVal(d.name, cb.checked));
    return h("label", { "class": "check" }, [cb, cb.checked ? "Ticked" : "Not ticked"]);
  }
  if (d.kind === "radio") {
    const box = h("div", { "class": "pf-opts", role: "radiogroup", "aria-label": d.label });
    const uniq = Array.from(new Set(d.options.length ? d.options : d.rects.map(r => r.opt).filter(Boolean)));
    uniq.forEach((o, i) => {
      const r = h("input", { type: "radio", name: id, value: o, id: i ? null : id, disabled: dis }); r.checked = v === o;
      r.addEventListener("change", () => { if (r.checked) setVal(d.name, o); });
      box.appendChild(h("label", { "class": "check" }, [r, o]));
    });
    if (!dis) {
      const clr = h("button", { "class": "btn ghost small", type: "button", text: "Clear" });
      clr.addEventListener("click", () => { $$("input", box).forEach(x => { x.checked = false; }); setVal(d.name, ""); });
      box.appendChild(clr);
    }
    return box;
  }
  if (d.kind === "dropdown" && d.editable && !d.multi) {
    const listId = id + "-list", el = h("input", { "class": "input", id, list: listId, dir: "auto", disabled: dis });
    el.value = (v && v[0]) || "";
    el.addEventListener("input", () => setVal(d.name, el.value ? [el.value] : []));
    return h("div", {}, [el, h("datalist", { id: listId }, d.options.map(o => h("option", { value: o })))]);
  }
  if (d.kind === "dropdown" || d.kind === "list") {
    const multi = d.multi, sel = h("select", { "class": "select", id, multiple: multi, disabled: dis, size: d.kind === "list" && !multi ? String(Math.min(5, Math.max(2, d.options.length))) : null });
    if (!multi && d.kind === "dropdown") sel.appendChild(h("option", { value: "", text: "— choose —" }));
    d.options.forEach(o => { const op = h("option", { value: o, text: o }); op.selected = (v || []).includes(o); sel.appendChild(op); });
    sel.addEventListener("change", () => setVal(d.name, $$("option", sel).filter(o => o.selected && o.value !== "").map(o => o.value)));
    return sel;
  }
  return h("p", { "class": "pf-note", text: d.kind === "signature" ? "Signature field. To sign, use PDF Sign." : "Button (nothing to fill in)." });
}
function buildPanel() {
  const box = $("#fields"); box.innerHTML = "";
  const groups = new Map();
  st.fields.forEach(d => { const k = d.page; if (!groups.has(k)) groups.set(k, []); groups.get(k).push(d); });
  groups.forEach((list, pg) => {
    const g = h("div", { "class": "pf-group" }, [h("div", { "class": "pf-gh", "data-page": pg }, [h("span", { text: pg < 0 ? "Not on a page" : "Page " + (pg + 1) }), h("span", { text: list.length + " field" + (list.length > 1 ? "s" : "") })])]);
    list.forEach(d => {
      const lbl = h("label", { "class": "pf-lbl", "for": "f" + st.fields.indexOf(d) }, [d.label, d.required ? h("span", { "class": "req", text: "*", title: "Required" }) : null,
        h("span", { "class": "faint", title: d.name, text: d.readOnly ? "read-only" : d.tip || (d.label !== d.name ? d.name : "") })]);
      const el = h("div", { "class": "pf-field", "data-name": d.name }, [lbl, inputFor(d)]);
      el.addEventListener("focusin", () => hot(d.name, false));
      g.appendChild(el);
    });
    box.appendChild(g);
  });
  counts();
}
$("#fields").addEventListener("click", e => { const gh = e.target.closest(".pf-gh"); if (gh && +gh.dataset.page >= 0) showPage(+gh.dataset.page); });
$("#fields").addEventListener("change", e => { // keep the checkbox caption honest
  if (e.target.type === "checkbox") e.target.parentNode.lastChild.textContent = e.target.checked ? "Ticked" : "Not ticked";
});

function hot(name, scrollPanel) {
  st.hot = name;
  const d = fd(name); if (!d) return;
  $$(".pf-field").forEach(e => e.classList.toggle("hot", e.dataset.name === name));
  if (d.page >= 0 && d.page !== st.page) showPage(d.page);
  $$(".pf-box").forEach(b => b.classList.toggle("hot", b.dataset.name === name));
  if (scrollPanel) { const el = fieldEl(name); if (el) { el.scrollIntoView({ block: "nearest", behavior: "smooth" }); const i = $("input,textarea,select", el); if (i && !i.disabled) i.focus({ preventScroll: true }); } }
}

// preview
let gen = 0;
async function showPage(i) {
  if (!st.js || i < 0 || i >= st.vps.length) return;
  st.page = i; const g = ++gen, pg = $("#page"), vp1 = st.vps[i];
  pg.style.aspectRatio = vp1.width + " / " + vp1.height;
  $("#pageNo").textContent = "Page " + (i + 1) + " of " + st.vps.length;
  $("#prev").disabled = i === 0; $("#next").disabled = i === st.vps.length - 1;
  $$("canvas", pg).forEach(c => c.remove());
  drawBoxes(); fitK();
  try {
    const page = await st.js.getPage(i + 1), w = pg.getBoundingClientRect().width || 600, dpr = Math.min(2, window.devicePixelRatio || 1);
    const vp = page.getViewport({ scale: w * dpr / vp1.width }), c = document.createElement("canvas");
    c.width = Math.round(vp.width); c.height = Math.round(vp.height);
    await page.render({ canvasContext: c.getContext("2d"), viewport: vp }).promise;
    if (g === gen) { $$("canvas", pg).forEach(x => x.remove()); pg.insertBefore(c, pg.firstChild); }
  } catch (e) { /* preview is best-effort */ }
}
function fitK() { const pg = $("#page"), vp = st.vps[st.page]; if (vp) pg.style.setProperty("--k", String(pg.getBoundingClientRect().width / vp.width)); }
if ("ResizeObserver" in window) new ResizeObserver(S3.debounce(fitK, 30)).observe($("#page"));
function drawBoxes() {
  const ov = $("#ov"), vp = st.vps[st.page]; ov.innerHTML = "";
  st.fields.forEach(d => d.rects.forEach(r => {
    if (r.page !== st.page || r.w <= 0 || r.h <= 0) return;
    const v = vp.convertToViewportRectangle([r.x, r.y, r.x + r.w, r.y + r.h]);
    const x = Math.min(v[0], v[2]), y = Math.min(v[1], v[3]), w = Math.abs(v[2] - v[0]), hh = Math.abs(v[3] - v[1]);
    const b = h("div", { "class": "pf-box" + (d.fillable ? "" : " ro") + (d.multiline ? " multi" : "") + (d.name === st.hot ? " hot" : ""), "data-name": d.name, "data-opt": r.opt == null ? null : r.opt, title: d.label }, [h("span")]);
    b.style.left = (x / vp.width * 100) + "%"; b.style.top = (y / vp.height * 100) + "%";
    b.style.width = (w / vp.width * 100) + "%"; b.style.height = (hh / vp.height * 100) + "%";
    b._h = hh; ov.appendChild(b); paintBox(b);
  }));
}
function paintBox(b) {
  const d = fd(b.dataset.name), v = st.vals.get(d.name), span = b.firstChild;
  let text = "", mark = false;
  if (d.kind === "text") text = v || "";
  else if (d.kind === "check") { text = v ? "✓" : ""; mark = true; }
  else if (d.kind === "radio") { text = v && v === b.dataset.opt ? "●" : ""; mark = true; }
  else if (d.kind === "dropdown" || d.kind === "list") text = (v || []).join(", ");
  if (d.kind === "list" && d.options.length) { // show the whole list with the picked rows highlighted
    span.innerHTML = "";
    d.options.forEach(o => span.appendChild(h("div", { "class": (v || []).includes(o) ? "pf-on" : "", text: o })));
    b.classList.add("filled", "multi");
    b.style.fontSize = "calc(var(--k) * " + Math.max(6, Math.min(11, b._h / d.options.length * 0.8)).toFixed(1) + "px)";
    return;
  }
  span.textContent = text;
  b.classList.toggle("mark", mark); b.classList.toggle("filled", !!text);
  const pt = mark ? Math.min(b._h * 0.8, 16) : d.multiline ? Math.min(11, b._h * 0.7) : Math.max(6, Math.min(b._h * 0.68, 12));
  b.style.fontSize = "calc(var(--k) * " + pt.toFixed(1) + "px)";
  span.dir = "auto";
}
$("#ov").addEventListener("click", e => { const b = e.target.closest(".pf-box"); if (b) hot(b.dataset.name, true); });
$("#prev").addEventListener("click", () => showPage(st.page - 1));
$("#next").addEventListener("click", () => showPage(st.page + 1));

function resetTo(mode) {
  st.fields.forEach(d => st.vals.set(d.name, mode === "orig" || !d.fillable ? d.orig : d.kind === "check" ? false : d.kind === "text" || d.kind === "radio" ? "" : []));
  st.dirty = mode !== "orig"; buildPanel(); drawBoxes();
}
$("#clear").addEventListener("click", () => resetTo("clear"));
$("#reset").addEventListener("click", () => resetTo("orig"));
$("#flatten").checked = !!S3.store("fill.flatten");
$("#flatten").addEventListener("change", () => S3.store("fill.flatten", $("#flatten").checked));

async function openFile(file) {
  try {
    const bytes = new Uint8Array(await S3.readFile(file)), doc = await loadLib(bytes), fields = analyse(doc);
    st.file = file; st.base = file.name.replace(/\.pdf$/i, "") || "form"; st.bytes = bytes;
    $("#dropCard").hidden = true;
    if (!fields.length) { $("#noForm").hidden = false; $("#work").hidden = true; return; }
    $("#noForm").hidden = true;
    let js = null; try { js = await openJs(bytes); } catch (e) { js = null; }
    if (st.js) st.js.destroy();
    st.js = js; st.vps = [];
    if (js) for (let i = 1; i <= js.numPages; i++) st.vps.push((await js.getPage(i)).getViewport({ scale: 1 }));
    st.fields = fields; st.vals = new Map(fields.map(d => [d.name, d.orig])); st.dirty = false; st.saved = false; st.hot = null;
    $("#fname").textContent = file.name;
    const xfa = safe(() => doc.getForm().hasXFA(), false);
    $("#xfa").hidden = !xfa;
    $("#xfa").textContent = "This is an XFA (LiveCycle) form. The XFA layer is removed on download so viewers show the standard form fields you filled here; complex dynamic layouts may look simpler.";
    $("#work").hidden = false;
    buildPanel();
    const first = fields.find(d => d.page >= 0);
    await showPage(first ? first.page : 0);
    if (!js) S3.toast("The preview isn't available for this file, but filling works.", "error");
  } catch (e) { S3.toast(e.message || "This file couldn't be opened", "error"); }
}
const fileInput = S3.drop($("#drop"), files => openFile(files[0]), { accept: ".pdf,application/pdf", multiple: false });
$("#change").addEventListener("click", () => fileInput.click());
$("#noFormOther").addEventListener("click", () => fileInput.click());
window.addEventListener("beforeunload", e => { if (st.dirty && !st.saved) { e.preventDefault(); e.returnValue = ""; } });

$("#save").addEventListener("click", async () => {
  const b = $("#save"); b.disabled = true;
  try {
    const flat = $("#flatten").checked, r = await fill(st.bytes, st.fields, st.vals, { flatten: flat });
    S3.download(new Blob([r.bytes], { type: "application/pdf" }), st.base + (flat ? "-filled-flat.pdf" : "-filled.pdf"));
    st.saved = true;
    if (r.noAp.length) S3.toast("Saved. " + r.noAp.length + " field(s) use characters the built-in font can't draw; the PDF asks the viewer to draw them.", "error");
    else S3.toast(flat ? "Saved and flattened" : "Saved: the form is still fillable");
    S3.done();
  } catch (e) { S3.toast(e.message || String(e), "error"); }
  b.disabled = false;
});

// ---------- sample + self-test ----------
async function sampleForm() {
  const d = await PDFDocument.create(), f = await d.embedFont(StandardFonts.Helvetica), fb = await d.embedFont(StandardFonts.HelveticaBold), form = d.getForm();
  const ink = rgb(0.16, 0.18, 0.22), grey = rgb(0.45, 0.48, 0.53), look = { borderColor: rgb(0.74, 0.77, 0.81), backgroundColor: rgb(0.97, 0.98, 0.99), borderWidth: 1 };
  const p = d.addPage([595.28, 841.89]), H = p.getHeight();
  p.drawRectangle({ x: 0, y: H - 90, width: 595.28, height: 90, color: rgb(0.05, 0.62, 0.6) });
  p.drawText("Membership application", { x: 48, y: H - 56, size: 24, font: fb, color: rgb(1, 1, 1) });
  const label = (t, x, y) => p.drawText(t, { x, y, size: 9.5, font: f, color: grey });
  const text = (name, x, y, w, hh, tip) => { label(tip, x, y + hh + 5); const t = form.createTextField(name); t.addToPage(p, Object.assign({ x, y, width: w, height: hh }, look)); return t; };
  text("applicant.fullName", 48, H - 150, 300, 22, "Full name");
  text("applicant.dateOfBirth", 368, H - 150, 180, 22, "Date of birth");
  text("applicant.email", 48, H - 200, 300, 22, "Email");
  text("applicant.phone", 368, H - 200, 180, 22, "Phone");
  label("Membership", 48, H - 232);
  const plan = form.createRadioGroup("membership");
  ["Monthly", "Yearly", "Student"].forEach((o, i) => { plan.addOptionToPage(o, p, Object.assign({ x: 48 + i * 110, y: H - 256, width: 14, height: 14 }, look)); p.drawText(o, { x: 68 + i * 110, y: H - 252, size: 10.5, font: f, color: ink }); });
  label("Country", 368, H - 232);
  const c = form.createDropdown("country"); c.addOptions(["Jordan", "Egypt", "Lebanon", "Saudi Arabia", "UAE", "Other"]); c.addToPage(p, Object.assign({ x: 368, y: H - 260, width: 180, height: 22 }, look));
  label("Interests (pick any)", 48, H - 290);
  const l = form.createOptionList("interests"); l.addOptions(["Swimming", "Yoga", "Weights", "Running club"]); l.enableMultiselect(); l.addToPage(p, Object.assign({ x: 48, y: H - 368, width: 200, height: 72 }, look));
  const n = text("notes", 268, H - 368, 280, 72, "Anything we should know?"); n.enableMultiline();
  const cb = form.createCheckBox("newsletter"); cb.addToPage(p, Object.assign({ x: 48, y: H - 402, width: 14, height: 14 }, look));
  p.drawText("Send me the monthly newsletter", { x: 68, y: H - 398, size: 10.5, font: f, color: ink });
  const agree = form.createCheckBox("agreeTerms"); agree.enableRequired(); agree.addToPage(p, Object.assign({ x: 48, y: H - 426, width: 14, height: 14 }, look));
  p.drawText("I agree to the club rules", { x: 68, y: H - 422, size: 10.5, font: f, color: ink });
  for (let i = 0; i < 8; i++) p.drawRectangle({ x: 48, y: H - 480 - i * 22, width: 500 - (i * 53) % 120, height: 8, color: rgb(0.92, 0.93, 0.95) });
  const p2 = d.addPage([595.28, 841.89]);
  p2.drawText("Emergency contact", { x: 48, y: H - 70, size: 18, font: fb, color: ink });
  [["emergency.name", "Name", H - 130], ["emergency.phone", "Phone", H - 180]].forEach(([nm, tip, y]) => { p2.drawText(tip, { x: 48, y: y + 27, size: 9.5, font: f, color: grey }); form.createTextField(nm).addToPage(p2, Object.assign({ x: 48, y, width: 300, height: 22 }, look)); });
  return d.save();
}
window.S3_DEMO = async () => {
  await openFile(new File([await sampleForm()], "Membership application.pdf", { type: "application/pdf" }));
  const set = (name, v) => { setVal(name, v); };
  set("applicant.fullName", "Sara Haddad"); set("applicant.dateOfBirth", "14/03/1996"); set("applicant.email", "sara@example.com");
  set("membership", "Yearly"); set("country", ["Jordan"]); set("interests", ["Swimming", "Yoga"]); set("newsletter", true);
  set("notes", "Prefer evening classes.");
  buildPanel(); drawBoxes(); hot("applicant.phone", false);
  await new Promise(r => setTimeout(r, 700));
};

window.S3_SELFTEST = async () => {
  const fails = [], ok = (c, m) => { if (!c) fails.push(m); };
  const d = await PDFDocument.create(), form = d.getForm(), p1 = d.addPage([600, 800]), p2 = d.addPage([600, 800]);
  form.createTextField("name").addToPage(p1, { x: 50, y: 700, width: 220, height: 22 });
  const notes = form.createTextField("notes"); notes.enableMultiline(); notes.addToPage(p1, { x: 50, y: 600, width: 300, height: 60 });
  form.createCheckBox("agree").addToPage(p1, { x: 50, y: 560, width: 14, height: 14 });
  const r = form.createRadioGroup("plan"); r.addOptionToPage("basic", p1, { x: 50, y: 520, width: 14, height: 14 }); r.addOptionToPage("pro", p1, { x: 90, y: 520, width: 14, height: 14 });
  const dd = form.createDropdown("country"); dd.addOptions(["Jordan", "Egypt", "UAE"]); dd.addToPage(p2, { x: 50, y: 700, width: 150, height: 22 });
  const ol = form.createOptionList("langs"); ol.addOptions(["Arabic", "English", "French"]); ol.enableMultiselect(); ol.addToPage(p2, { x: 50, y: 600, width: 150, height: 60 });
  form.createButton("go").addToPage("Go", p2, { x: 300, y: 600, width: 60, height: 22 });
  const bytes = await d.save();
  const fields = analyse(await loadLib(bytes)), by = n => fields.find(x => x.name === n) || {};
  ok(fields.length === 7, "7 fields found");
  ok(by("name").kind === "text" && by("notes").multiline && by("agree").kind === "check" && by("plan").kind === "radio" && by("country").kind === "dropdown" && by("langs").kind === "list" && by("langs").multi && by("go").kind === "button" && !by("go").fillable, "field kinds");
  ok(by("name").page === 0 && by("plan").page === 0 && by("country").page === 1 && by("langs").page === 1, "pages");
  ok(by("plan").rects.map(x => x.opt).join() === "basic,pro" && by("country").options.join() === "Jordan,Egypt,UAE", "options");
  ok(fields.slice(0, 4).map(x => x.name).join() === "name,notes,agree,plan", "visual order");
  const vals = new Map([["name", "Sara Haddad"], ["notes", "Line one\nLine two"], ["agree", true], ["plan", "pro"], ["country", ["Egypt"]], ["langs", ["Arabic", "English"]]]);
  const r1 = await fill(bytes, fields, vals, {}), f1 = (await PDFDocument.load(r1.bytes)).getForm();
  ok(f1.getTextField("name").getText() === "Sara Haddad" && f1.getTextField("notes").getText() === "Line one\nLine two", "text values saved");
  ok(f1.getCheckBox("agree").isChecked() && f1.getRadioGroup("plan").getSelected() === "pro", "checkbox + radio saved");
  ok(f1.getDropdown("country").getSelected().join() === "Egypt" && f1.getOptionList("langs").getSelected().join() === "Arabic,English", "dropdown + list saved");
  ok(f1.getFields().length === 7, "still fillable without flatten");
  const r2 = await fill(bytes, fields, vals, { flatten: true }), d2 = await PDFDocument.load(r2.bytes);
  ok(d2.getForm().getFields().length === 0 && d2.getPageCount() === 2, "flatten removes the fields");
  const js = await openJs(r2.bytes), t1 = (await (await js.getPage(1)).getTextContent()).items.map(x => x.str).join(" "), t2 = (await (await js.getPage(2)).getTextContent()).items.map(x => x.str).join(" ");
  ok(t1.indexOf("Sara Haddad") >= 0 && t2.indexOf("Egypt") >= 0, "flattened answers are on the page");
  js.destroy();
  const ar = new Map(vals); ar.set("name", "سارة حداد");
  const r3 = await fill(bytes, fields, ar, {}), d3 = await PDFDocument.load(r3.bytes);
  ok(d3.getForm().getTextField("name").getText() === "سارة حداد" && r3.noAp.length === 1 && d3.getForm().acroForm.dict.get(PDFName.of("NeedAppearances")) === PDFBool.True, "Arabic value kept, viewer asked to draw it");
  let threw = ""; try { await fill(bytes, fields, ar, { flatten: true }); } catch (e) { threw = e.message; }
  ok(/Can't flatten/.test(threw), "flattening Arabic explains why it can't");
  const plain = await PDFDocument.create(); plain.addPage();
  ok(analyse(await loadLib(await plain.save())).length === 0, "no-form PDF detected");
  ok(humanize("applicant.dateOfBirth") === "Date of birth" && humanize("passportID") === "Passport ID" && humanize("first_name") === "First name", "labels");
  return fails.length ? fails : true;
};
