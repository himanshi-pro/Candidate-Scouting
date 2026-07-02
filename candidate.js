/**
 * candidate.js
 * Powers the Shortlist and Close buttons on standalone, per-candidate
 * dossier pages (e.g. candidate-dossier-amay-dixit.html).
 *
 * These pages are static exports of what the main dashboard renders inline —
 * they need their own small script because they don't have the rest of the
 * dashboard's DOM (table, identity gate, etc.) that script.js expects.
 *
 * It uses the *same* storage keys as script.js, so a shortlist made here
 * shows up in index.html's table, and vice versa.
 *
 * REQUIRED: add two data attributes to this page's <body> tag before
 * including this script:
 *   <body data-student-id="amay-dixit-iit-bhilai" data-student-name="Amay Dixit">
 *
 * The id must be generated the exact same way script.js generates it:
 * lowercase, non-alphanumeric runs replaced with "-", trimmed of
 * leading/trailing "-", as  slug(name) + "-" + slug(university).
 * See the buildId() helper at the bottom of this file if you're
 * generating these pages programmatically.
 */
(function () {
  "use strict";

  // Must match script.js exactly — this is what makes shortlists shared.
  const SHORTLIST_KEY = "polaris_r3_shortlists";
  const COMPANY_PREF_KEY = "polaris_r3_current_company";
  const INDEX_PAGE = "index.html"; // where "Exit"/close and "pick a company" send you

  const studentId = document.body.getAttribute("data-student-id");
  const studentName = document.body.getAttribute("data-student-name") || "this candidate";

  if (!studentId) {
    console.error("candidate.js: <body> is missing data-student-id — shortlist button can't work without it.");
    return;
  }

  function titleCase(str) {
    return str.replace(/\w\S*/g, w => w[0].toUpperCase() + w.slice(1).toLowerCase());
  }

  async function getCurrentCompany() {
    try {
      const res = await window.storage.get(COMPANY_PREF_KEY, false);
      return res && res.value ? res.value : null;
    } catch (e) {
      return null;
    }
  }

  async function getShortlists() {
    try {
      const res = await window.storage.get(SHORTLIST_KEY, true);
      return res && res.value ? JSON.parse(res.value) : {};
    } catch (e) {
      return {};
    }
  }

  async function saveShortlists(shortlists) {
    try {
      await window.storage.set(SHORTLIST_KEY, JSON.stringify(shortlists), true);
    } catch (e) {
      console.error("candidate.js: could not save shortlist", e);
    }
  }

  function renderShortlistState(btn, box, company, shortlisters) {
    const alreadyDone = !!company && shortlisters.includes(company);

    const top = box.querySelector(".mono");
    if (top) {
      top.textContent = shortlisters.length > 0
        ? `Shortlisted by ${shortlisters.length} compan${shortlisters.length === 1 ? "y" : "ies"}`
        : "Not shortlisted yet";
    }

    let list = box.querySelector(".companies-list");
    if (shortlisters.length > 0) {
      const html = `<b>Companies:</b> ${shortlisters.map(c => titleCase(c)).join(", ")}`;
      if (!list) {
        list = document.createElement("div");
        list.className = "companies-list";
        box.appendChild(list);
      }
      list.innerHTML = html;
    } else if (list) {
      list.remove();
    }

    btn.textContent = alreadyDone ? "✓ Shortlisted — click to remove" : (company ? `Shortlist as ${titleCase(company)}` : "Shortlist");
    btn.classList.toggle("shortlisted", alreadyDone);
    btn.title = company ? "" : "Click to pick your company on the dashboard first";
  }

  async function init() {
    const company = await getCurrentCompany();
    const shortlists = await getShortlists();
    const shortlisters = shortlists[studentId] || [];

    const btn = document.querySelector(".shortlist-btn");
    const box = document.querySelector(".dossier-shortlist-box");
    if (!btn || !box) return;

    renderShortlistState(btn, box, company, shortlisters);

    btn.addEventListener("click", async () => {
      if (!company) {
        // No identity chosen yet on this browser — send them to pick one first.
        window.location.href = INDEX_PAGE;
        return;
      }
      const latest = await getShortlists();
      const list = latest[studentId] || [];
      if (list.includes(company)) {
        latest[studentId] = list.filter(c => c !== company);
      } else {
        latest[studentId] = [...list, company];
      }
      await saveShortlists(latest);
      renderShortlistState(btn, box, company, latest[studentId] || []);
    });

    // Close (✕) button — this is a standalone page, not a modal, so "close"
    // means go back to the dashboard.
    const closeBtn = document.querySelector(".dossier-close");
    if (closeBtn) {
      closeBtn.addEventListener("click", () => {
        window.location.href = INDEX_PAGE;
      });
    }
  }

  init();
})();

/**
 * Reference only — same slug logic as script.js. Use this if you're
 * generating these pages programmatically, to make sure the id you embed
 * in data-student-id matches what the main dashboard computes for the
 * same person.
 *
 * function slug(str) {
 *   return String(str || "").toLowerCase().trim()
 *     .replace(/[^a-z0-9]+/g, "-")
 *     .replace(/(^-|-$)/g, "");
 * }
 * function buildId(name, university) {
 *   return slug(name) + (university ? "-" + slug(university) : "");
 * }
 */
