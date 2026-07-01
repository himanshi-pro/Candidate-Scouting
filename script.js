(function(){
  "use strict";

  /* ---------------- localStorage fallback for persistent data storage ---------------- */
  if (!window.storage) {
    window.storage = {
      get: async function(key, shared) {
        try {
          const value = localStorage.getItem(key);
          return value ? { value } : null;
        } catch (e) {
          return null;
        }
      },
      set: async function(key, value, shared) {
        try {
          localStorage.setItem(key, value);
        } catch (e) {
          console.error("Could not save to localStorage:", e);
        }
      },
      delete: async function(key, shared) {
        try {
          localStorage.removeItem(key);
        } catch (e) {
          console.error("Could not delete from localStorage:", e);
        }
      }
    };
  }

  /* ---------------- Live Google Sheets source (gviz JSONP — works even from file://) ---------------- */
  const SHEET_ID = "1gAIhAvT0c0oPIFrPKweJ6PkYFKa7kltg6P_pjd9_Igw";
  const STUDENTS_TAB = "Students";
  const COMPANIES_TAB = "Companies";
  const REFRESH_MS = 45000; // re-check the sheet for edits every 45s

  let jsonpCounter = 0;

  // Loads one tab via a <script> tag instead of fetch(). Script tags aren't subject
  // to CORS or to the file:// restrictions that block fetch()/XHR, which makes this
  // work whether the dashboard is opened locally by double-click or hosted online.
  function fetchTabViaJsonp(tabName){
    return new Promise((resolve, reject) => {
      jsonpCounter += 1;
      const cbName = `__gvizCb_${Date.now()}_${jsonpCounter}`;
      const url = `https://docs.google.com/spreadsheets/d/${SHEET_ID}/gviz/tq?tqx=out:json;responseHandler:${cbName}&headers=1&sheet=${encodeURIComponent(tabName)}&_ts=${Date.now()}`;

      let settled = false;
      const script = document.createElement("script");

      const cleanup = () => {
        delete window[cbName];
        if (script.parentNode) script.parentNode.removeChild(script);
        clearTimeout(timer);
      };

      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        cleanup();
        reject(new Error(`Timed out loading the "${tabName}" tab.`));
      }, 15000);

      window[cbName] = (data) => {
        if (settled) return;
        settled = true;
        cleanup();
        if (!data || !data.table) {
          reject(new Error(`Unexpected response for the "${tabName}" tab.`));
          return;
        }
        resolve(data.table);
      };

      script.onerror = () => {
        if (settled) return;
        settled = true;
        cleanup();
        reject(new Error(`Could not reach the "${tabName}" tab — check that the sheet is shared and the tab name is correct.`));
      };

      script.src = url;
      document.head.appendChild(script);
    });
  }

  // Convert a gviz `table` object into { fields, data } shaped like Papa.parse's output,
  // so the rest of the pipeline below doesn't need to change.
  function tableToRows(table){
    const fields = (table.cols || []).map((c, i) => (c.label && c.label.trim()) || c.id || `Column ${i + 1}`);
    const data = (table.rows || []).map(row => {
      const obj = {};
      fields.forEach((field, i) => {
        const cell = row.c && row.c[i];
        let value = "";
        if (cell) {
          value = (cell.f !== undefined && cell.f !== null) ? cell.f : cell.v;
        }
        obj[field] = value === null || value === undefined ? "" : String(value);
      });
      return obj;
    });
    return { fields, data };
  }

  function titleCase(str){
    return str.replace(/\w\S*/g, w => w[0].toUpperCase() + w.slice(1).toLowerCase())
              .replace(/\bAi\b/g, "AI");
  }

  function slug(str){
    return String(str || "").toLowerCase().trim()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/(^-|-$)/g, "");
  }

  /* ---------------- Field classification helpers ---------------- */
  let RAW_HEADERS = [];
  let COMPANIES = [];
  let NAME_KEY = null, UNIVERSITY_KEY = null, EMAIL_KEY = null, PHONE_KEY = null;
  let CONTACT_KEYS = [];
  // Semantic roles used by the analysis engine below — found by pattern, not hardcoded,
  // so this still degrades gracefully if the sheet's questions are reworded.
  let PROGRAM_KEY = null, GRADYEAR_KEY = null, CITY_KEY = null, TECHSTACK_KEY = null;
  let WHY_KEY = null, PROUD_KEY = null, BESTPROJECT_KEY = null, SELFTAUGHT_KEY = null;
  let REPOEXPLAIN_KEY = null, DEBUG_KEY = null, VALIDATION_KEY = null;
  let STUDENTS = [];

  function findHeader(regex){
    return RAW_HEADERS.find(h => regex.test(h));
  }

  function isUrl(value){
    return typeof value === "string" && /^https?:\/\/\S+$/i.test(value.trim());
  }

  function shortLinkLabel(header){
    const h = header.toLowerCase();
    if (h.includes("linkedin")) return "LinkedIn";
    if (h.includes("github")) return "GitHub";
    if (h.includes("resume") || h.includes("cv")) return "Resume";
    if (h.includes("portfolio")) return "Portfolio";
    if (h.includes("video")) return "Intro Video";
    if (h.includes("repo") || h.includes("demo") || h.includes("artifact") || h.includes("project")) return "Project Link";
    if (h.includes("certificat")) return "Certificate";
    if (h.includes("drive")) return "Drive Link";
    // fallback: trim header to a short label
    const words = header.split(/\s+/).slice(0, 3).join(" ");
    return words.length > 28 ? words.slice(0, 28) + "…" : words;
  }

  function cleanLongLabel(header){
    // Use header as-is for long-text section titles, trimmed of trailing punctuation.
    return header.replace(/\s+/g, " ").trim();
  }

  function initials(name){
    if (!name) return "?";
    const parts = name.trim().split(/\s+/);
    return ((parts[0]?.[0] || "") + (parts[1]?.[0] || "")).toUpperCase();
  }

  function escapeHtml(str){
    return String(str)
      .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  /* ---------------- Build normalized student objects ---------------- */
  /* =====================================================================
     STUDENT ANALYSIS ENGINE
     Adapted from student-analysis-logic.js. The original module's
     getAiAnalysis()/buildPrompt()/parseAiJson() called api.anthropic.com
     directly from the browser — that call has no way to succeed here
     (no key, no server to hold one), so it was silently failing on every
     student and always falling through to the heuristic fallback, which
     only produced generic canned category labels ("Internship experience",
     "Strong portfolio"...) with nothing specific to the actual person.
     That live-API path is removed entirely below. In its place, the
     heuristic layer itself now pulls the actual sentence that triggered
     each match out of the student's own free-text answers, so what's
     shown is that person's specific words, not a canned label.
     Renamed getAiAnalysis -> computeStudentAnalysis to reflect that it's
     a plain synchronous function now, not an async AI call.
     ===================================================================== */

  var SKILL_DICT = {
    "Programming Languages": ["java","python","javascript","typescript","c++","c#","c","golang","go","rust","kotlin","swift","php","ruby","r","sql","html","css","dart","scala","bash","shell","matlab"],
    "Frameworks": ["react","reactjs","angular","angularjs","vue","vuejs","node.js","nodejs","express","django","flask","spring","fastapi","next.js","nextjs",".net","streamlit","mern","bootstrap","tailwind","jquery","laravel","nestjs","redux","react native","flutter","electron","hibernate","jpa"],
    "Databases": ["mongodb","mongo","mysql","postgresql","postgres","postgress","sqlite","redis","firebase","dynamodb","cassandra","oracle db","mariadb","supabase","neo4j","elasticsearch","nosql"],
    "Cloud": ["aws","azure","gcp","google cloud","vercel","netlify","heroku","cloudflare","digitalocean","s3","ec2","lambda"],
    "DevOps": ["docker","kubernetes","ci/cd","jenkins","github actions","terraform","ansible","nginx","linux","git","github","gitlab","k8s","eks","helm","maven"],
    "AI / ML": ["nlp","llm","llms","generative ai","tensorflow","pytorch","scikit-learn","sklearn","opencv","machine learning","deep learning","face api","rag","prompt engineering","computer vision","keras","langchain","hugging face","huggingface","transformers","genai","ai/ml","artificial intelligence","openai","claude","gemini","bert","gpt","nemo","asr","conformer","cuda","vector database"],
    "Tools": ["postman","figma","jira","vs code","notion","slack","excel","power bi","tableau","canva","adobe","webpack","vite"]
  };

  function isWordChar(ch){ return ch !== undefined && /[a-z0-9]/i.test(ch); }

  function keywordMatches(haystackLower, keyword){
    var idx = haystackLower.indexOf(keyword);
    if (idx === -1) return false;
    var before = idx === 0 ? undefined : haystackLower[idx - 1];
    var after = (idx + keyword.length >= haystackLower.length) ? undefined : haystackLower[idx + keyword.length];
    return !isWordChar(before) && !isWordChar(after);
  }

  var SKIP_SEGMENT_LABELS = /^(coursework|soft skills?|academics?)$/i;

  function categorizeStack(stackStr){
    var out = {"Programming Languages":[], "Frameworks":[], "Databases":[], "Cloud":[], "DevOps":[], "AI / ML":[], "Tools":[], "Other Technologies":[]};
    if (!stackStr) return out;

    var segments = stackStr.split("//").map(function(s){ return s.trim(); }).filter(Boolean);
    var rawTokens = [];
    segments.forEach(function(seg){
      var labelMatch = seg.match(/^([A-Za-z &/]{2,30}):\s*(.*)$/);
      var label = labelMatch ? labelMatch[1].trim() : null;
      var content = labelMatch ? labelMatch[2] : seg;
      if (label && SKIP_SEGMENT_LABELS.test(label)) return;
      content = content.replace(/[()]/g, ",");
      var tokens = content.split(/[,/]|(?:\s+and\s+)/i).map(function(t){ return t.trim().replace(/\.$/, ""); }).filter(Boolean);
      rawTokens = rawTokens.concat(tokens);
    });

    rawTokens = Array.from(new Set(rawTokens.filter(function(t){ return t.length > 0 && t.length < 45; })));

    rawTokens.forEach(function(tok){
      var low = tok.toLowerCase();
      var placed = false;
      var catOrder = ["Programming Languages","Databases","Cloud","DevOps","Frameworks","AI / ML","Tools"];
      for (var c = 0; c < catOrder.length; c++){
        var cat = catOrder[c];
        var kws = SKILL_DICT[cat];
        for (var i = 0; i < kws.length; i++){
          if (keywordMatches(low, kws[i].trim())){
            out[cat].push(tok);
            placed = true;
            break;
          }
        }
        if (placed) break;
      }
      if (!placed) out["Other Technologies"].push(tok);
    });

    return out;
  }

  var HIGHLIGHT_RULES = [
    { key: "hackathon", label: "Hackathon experience", icon: "🏆", patterns: [/hackathon/i] },
    { key: "opensource", label: "Open source contributor", icon: "🌐", patterns: [/open[\s-]?source/i] },
    { key: "internship", label: "Internship experience", icon: "💼", patterns: [/intern(ship)?s?\b/i] },
    { key: "github", label: "Active GitHub presence", icon: "💻", patterns: [/github/i] },
    { key: "competitive", label: "Competitive programming", icon: "⚡", patterns: [/competitive programming/i, /leetcode/i, /codeforces/i, /codechef/i, /\bcp\b/] },
    { key: "research", label: "Research work", icon: "🔬", patterns: [/\bresearch\b/i] },
    { key: "publication", label: "Published work", icon: "📄", patterns: [/publicat(ion|ed)/i, /\bpaper\b/i, /journal/i] },
    { key: "certification", label: "Certifications", icon: "📜", patterns: [/certif(ied|ication)/i] },
    { key: "cloud_infra", label: "Cloud / infra work", icon: "☁️", patterns: [/deployed?/i, /\baws\b/i, /\bazure\b/i, /\bcloud\b/i] },
    { key: "startup", label: "Startup experience", icon: "🚀", patterns: [/startup/i, /\bfounder\b/i, /co-founder/i] },
    { key: "award", label: "Award / recognition", icon: "🏅", patterns: [/\baward\b/i, /\bwinner\b/i, /\bwon\b/i, /\brank(ed)?\b/i, /top \d/i] },
    { key: "leadership", label: "Leadership role", icon: "🧭", patterns: [/lead(er|ership)?\b/i, /\bpresident\b/i, /\bhead\b/i, /founder/i, /captain/i] },
    { key: "freelance", label: "Freelance work", icon: "🧾", patterns: [/freelanc/i] },
    { key: "mentor", label: "Teaching / mentoring", icon: "🎓", patterns: [/mentor/i, /\bteach(ing)?\b/i, /\btutor/i] },
    { key: "community", label: "Community contribution", icon: "🤝", patterns: [/community/i, /volunteer/i, /\bclub\b/i] }
  ];

  // Fields scanned for narrative highlight extraction, richest/most-personal first.
  function narrativeFields(student){
    return [student.proudAchievement, student.bestProject, student.whyFellowship,
      student.selfTaught, student.repoExplain, student.debugStory];
  }

  function detectHighlights(student){
    var text = narrativeFields(student).concat([student.validationReason, student.techStack]).join(" \n ");
    var found = [];
    HIGHLIGHT_RULES.forEach(function(rule){
      var hit = rule.patterns.some(function(p){ return p.test(text); });
      if (hit) found.push({ key: rule.key, label: rule.label, icon: rule.icon });
    });
    return found;
  }

  /** Splits free text into rough sentences/clauses for snippet extraction. */
  function truncate(t, n){
    if (!t) return t;
    t = t.trim();
    if (t.length <= n) return t;
    return t.slice(0, n).replace(/\s+\S*$/, "") + "…";
  }

  /** Converts first-person free text to third person (singular "they"), so nothing
   *  quoted from a student's own answers reads as "I built X" in their dossier. */
  function toThirdPerson(text){
    if (!text) return text;
    return text
      .replace(/\bI'm\b/g, "They're")
      .replace(/\bI've\b/g, "They've")
      .replace(/\bI'll\b/g, "They'll")
      .replace(/\bI'd\b/g, "They'd")
      .replace(/\bI am\b/g, "they are")
      .replace(/\bI have\b/g, "they have")
      .replace(/\bI had\b/g, "they had")
      .replace(/\bI was\b/g, "they were")
      .replace(/\bI will\b/g, "they will")
      .replace(/\bI would\b/g, "they would")
      .replace(/\bmyself\b/gi, "themselves")
      .replace(/\bmy\b/g, "their")
      .replace(/\bMy\b/g, "Their")
      .replace(/\bme\b/g, "them")
      .replace(/\bI\b/g, "they")
      .replace(/^./, function(c){ return c.toUpperCase(); });
  }

  /** Strips a generic first-person lead-in ("The best project I have built is...")
   *  so a bullet starts directly on the substance instead of restating the question. */
  var LEAD_INS = [
    /^the best project i(?:'ve| have) built is\s*/i,
    /^a recent achievement i(?:'m| am) (?:most )?proud of (?:is|was)\s*/i,
    /^the achievement i(?:'m| am) most proud of is\s*/i,
    /^during my\s+/i,
    /^i believe\s+/i,
    /^i(?:'m| am)\s+/i
  ];
  function stripLeadIn(t){
    var out = t;
    for (var i = 0; i < LEAD_INS.length; i++){
      if (LEAD_INS[i].test(out)){ out = out.replace(LEAD_INS[i], ""); break; }
    }
    return out.charAt(0).toUpperCase() + out.slice(1);
  }

  function joinNatural(arr){
    if (arr.length === 0) return "";
    if (arr.length === 1) return arr[0];
    if (arr.length === 2) return arr[0] + " and " + arr[1];
    return arr.slice(0, -1).join(", ") + ", and " + arr[arr.length - 1];
  }

  /* ---------------------------------------------------------------------
     FACT EXTRACTION: pulls specific counts, program names, and org names
     out of a student's own text per achievement category, instead of
     quoting a sentence or falling back to a generic category label.
     e.g. "3 internships completed", "Selected for GSoC (2025)",
          "Solved 1600+ DSA problems (Knight-rated on LeetCode)"
     --------------------------------------------------------------------- */

  function looksLikeYear(n){
    return n >= 1900 && n <= 2099 && String(n).length === 4;
  }

  function numNear(text, nounSrc){
    var re = new RegExp("(\\d[\\d,]*)\\+?\\s*(?:x\\s*)?(?:times?\\s*)?(?:" + nounSrc + ")", "i");
    var m = text.match(re);
    if (m){
      var n1 = parseInt(m[1].replace(/,/g, ""), 10);
      if (!looksLikeYear(n1)) return n1;
    }
    var re2 = new RegExp("(?:" + nounSrc + ")[^\\d]{0,18}(\\d[\\d,]*)\\+?", "i");
    var m2 = text.match(re2);
    if (m2){
      var n2 = parseInt(m2[1].replace(/,/g, ""), 10);
      if (!looksLikeYear(n2)) return n2;
    }
    return null;
  }

  var FACT_EXTRACTORS = {
    internship: function(text){
      var n = numNear(text, "intern(?:ship)?s?");
      var company = text.match(/[Ii]ntern(?:ed|ship)?\s+at\s+([A-Z][A-Za-z0-9&.\- ]{2,30})/);
      if (n) return n + " internship" + (n > 1 ? "s" : "") + " completed" + (company ? " (incl. " + company[1].trim() + ")" : "");
      if (company) return "Interned at " + company[1].trim();
      return "Internship experience";
    },
    opensource: function(text){
      var progs = [];
      [[/g(?:oogle)? ?soc\b|google summer of code/i, "GSoC"],
       [/outreachy/i, "Outreachy"],
       [/summer of bitcoin/i, "Summer of Bitcoin"],
       [/girlscript summer of code|gssoc/i, "GirlScript Summer of Code"],
       [/\blfx\b/i, "LFX Mentorship"],
       [/\bc4gt\b/i, "Code for GovTech"],
       [/hacktoberfest/i, "Hacktoberfest"]
      ].forEach(function(pair){ if (pair[0].test(text) && progs.indexOf(pair[1]) === -1) progs.push(pair[1]); });
      var year = text.match(/\b(20\d{2})\b/);
      if (progs.length) return "Selected for " + joinNatural(progs) + (year ? " (" + year[1] + ")" : "");
      return "Open source contributor";
    },
    github: function(text){
      var stars = text.match(/(\d[\d,]*)\+?\s*(?:github\s*)?stars?/i);
      if (stars) return stars[1] + "+ GitHub stars earned on personal projects";
      return "Active GitHub contributor";
    },
    hackathon: function(text){
      var count = numNear(text, "(?:global\\s+)?hackathons?");
      var isWinner = /\bwon\b|\bwinner\b|\bwins\b|\bfirst place\b/i.test(text);
      var named = text.match(/([A-Z][A-Za-z0-9&' ]{2,40}\bHackathon\b)/);
      if (count) return count + "× hackathon " + (isWinner ? "winner" : "participant") + (named ? " (" + named[1].trim() + ")" : "");
      if (named) return (isWinner ? "Won " : "Competed in ") + named[1].trim();
      return isWinner ? "Hackathon winner" : "Hackathon experience";
    },
    research: function(text){
      if (/\bieee\b/i.test(text)) return "Co-authored an IEEE conference paper";
      var venue = text.match(/([A-Z][A-Za-z0-9 ]{4,40}(?:Journal|Conference|Symposium))/);
      if (venue) return "Published research at " + venue[1].trim();
      if (/publicat(ion|ed)|\bpaper\b|journal/i.test(text)) return "Published research work";
      return "Research experience";
    },
    publication: function(text){
      if (/\bieee\b/i.test(text)) return "Co-authored an IEEE conference paper";
      return "Published work";
    },
    leadership: function(text){
      var team = text.match(/(\d+)[- ]?\+?\s*(?:member|people|students?)\s*(?:team|group)?/i);
      if (team) return "Leads a " + team[1] + "-member team";
      var role = text.match(/\b(president|co-founder|founder|captain|head)\b/i);
      if (role) return role[1].charAt(0).toUpperCase() + role[1].slice(1).toLowerCase() + " / leadership role";
      return "Leadership role";
    },
    award: function(text){
      var named = text.match(/(?:[Ww]on|[Ww]inner of|[Ss]ecured|[Aa]warded|[Rr]unner[- ]?up (?:at|in))\s+([A-Z][A-Za-z0-9&']{2,}(?:\s[A-Z][A-Za-z0-9&']{2,}){0,6})/);
      if (named) return "Recognized: " + named[1].trim();
      var rank = text.match(/top\s+(\d+)(?:\s+out of\s+(?:more than\s+)?(\d[\d,]*))?/i);
      if (rank) return "Ranked top " + rank[1] + (rank[2] ? (" of " + rank[2]) : "");
      return "Award / recognition";
    },
    certification: function(text){
      var n = numNear(text, "certificat\\w*");
      if (n) return n + " professional certification" + (n > 1 ? "s" : "");
      return "Certified in relevant technologies";
    },
    competitive: function(text){
      var solved = text.match(/(\d[\d,]*)\+?\s*(?:dsa\s*)?problems/i);
      var knight = /knight/i.test(text);
      if (solved) return "Solved " + solved[1] + "+ DSA problems" + (knight ? " (Knight-rated on LeetCode)" : "");
      if (knight) return "Knight-rated competitive programmer";
      return "Competitive programming background";
    },
    freelance: function(){ return "Freelance project experience"; },
    mentor: function(text){
      var n = numNear(text, "(?:students?|mentees?|people)");
      if (n) return "Mentored " + n + "+ students";
      return "Teaching / mentoring experience";
    },
    startup: function(text){
      var named = text.match(/(?:[Ff]ounded|[Cc]o-founded|[Ff]ounder of)\s+([A-Z][A-Za-z0-9&']{1,}(?:\s[A-Z][A-Za-z0-9&'.\-]{1,}){0,4})/);
      if (named) return "Founded " + named[1].trim();
      return "Startup / founder experience";
    },
    community: function(){ return "Active community contributor"; },
    cloud_infra: function(text){
      var pct = text.match(/(?:reduced?|cut|improved?).{0,25}(?:by\s+)?(\d{1,3})%/i) || text.match(/(\d{1,3})%\s*(?:reduction|faster|improvement)/i);
      if (pct) return "Improved system performance by " + pct[1] + "%";
      return "Cloud / infrastructure deployment experience";
    }
  };

  /**
   * For each matched achievement category, computes a specific, factual
   * phrase (a count, a named program, an org) from the student's own text —
   * not a quoted sentence and not a generic label.
   */
  function computeFactHighlights(student){
    var text = narrativeFields(student).concat([student.validationReason, student.techStack]).filter(Boolean).join(" \n ");
    var out = [];
    HIGHLIGHT_RULES.forEach(function(rule){
      var hit = rule.patterns.some(function(p){ return p.test(text); });
      if (!hit) return;
      var extractor = FACT_EXTRACTORS[rule.key];
      var phrase = extractor ? extractor(text) : rule.label;
      out.push({ key: rule.key, icon: rule.icon, text: phrase });
    });
    return out.slice(0, 6);
  }

  function fieldFilled(v){ return v && String(v).trim().length > 0; }

  var COMPLETENESS_FIELDS = ["linkedin","github","portfolio","resume","techStack","whyFellowship",
    "introVideo","proudAchievement","bestProject","selfTaught","repoLink","repoExplain","debugStory","validationReason"];

  function completeness(student){
    var filled = COMPLETENESS_FIELDS.filter(function(f){ return fieldFilled(student[f]); }).length;
    return Math.round((filled / COMPLETENESS_FIELDS.length) * 100);
  }

  function textRichness(student){
    var t = [student.proudAchievement, student.bestProject, student.selfTaught, student.repoExplain, student.debugStory].join(" ");
    return t.split(/\s+/).filter(Boolean).length;
  }

  function signalScore(student){
    var hl = detectHighlights(student).length;
    var comp = completeness(student);
    var rich = textRichness(student);
    var linkBonus = ["linkedin","github","portfolio","resume"].filter(function(f){ return fieldFilled(student[f]); }).length;

    var score = 0;
    score += Math.min(hl, 8) * 6.5;
    score += (comp / 100) * 22;
    score += Math.min(rich / 400, 1) * 16;
    score += linkBonus * 2.5;
    return Math.max(5, Math.min(100, Math.round(score)));
  }

  function signalStars(score){
    return Math.max(1, Math.min(5, Math.round(score / 20)));
  }

  /** Builds a natural, third-person summary from computed facts — never quotes raw first-person text. */
  var TECH_HIGHLIGHT_KEYS = ["hackathon", "opensource", "internship", "github", "competitive",
    "research", "publication", "certification", "cloud_infra", "startup"];

  function firstClause(text, maxLen){
    if (!text) return "";
    var cut = text.split(/[.!?\n]/)[0].trim();
    return truncate(cut, maxLen).replace(/\.$/, "");
  }

  function buildSummary(student, factHighlights){
    var name = student.name || "This candidate";
    var cats = categorizeStack(student.techStack);
    var topSkills = []
      .concat(cats["Programming Languages"].slice(0, 3))
      .concat(cats["Frameworks"].slice(0, 2))
      .concat(cats["AI / ML"].slice(0, 2));
    topSkills = topSkills.slice(0, 5);

    var parts = [];
    parts.push(name + " is a " + (student.program || "engineering") + " student at " + (student.university || "their university") +
      (student.gradYear ? (", graduating in " + student.gradYear) : "") + ".");
    if (topSkills.length){
      parts.push("Their technical strengths center on " + joinNatural(topSkills) + ".");
    }

    // Prefer hard technical signals (hackathons, internships, OSS, research...) over soft ones
    // (leadership, mentoring) when picking what to call out — falls back to whatever's matched
    // only if nothing tech-specific was found.
    var techFacts = factHighlights.filter(function(h){ return TECH_HIGHLIGHT_KEYS.indexOf(h.key) !== -1; });
    var chosen = (techFacts.length ? techFacts : factHighlights).slice(0, 3).map(function(h){ return h.text; });
    if (chosen.length){
      parts.push("They stand out for " + joinNatural(chosen) + ".");
    }

    // Clean, tech-focused closer built from their own project description — never the raw
    // validation-reason shorthand (which reads like reviewer notes, not a sentence).
    var bestProjectClause = student.bestProject ? firstClause(toThirdPerson(stripLeadIn(student.bestProject)), 95) : "";
    if (bestProjectClause){
      parts.push("Best known for building " + bestProjectClause + ".");
    } else if (topSkills.length >= 2){
      parts.push("A solid technical fit for teams working with " + topSkills.slice(0, 2).join(" and ") + ".");
    }

    return parts.join(" ").trim();
  }

  /** Third-person, lead-stripped experience bullets — not verbatim first-person quotes. */
  function experienceBullets(student){
    var out = [];
    if (student.proudAchievement) out.push(truncate(toThirdPerson(stripLeadIn(student.proudAchievement)), 160));
    if (student.bestProject) out.push(truncate(toThirdPerson(stripLeadIn(student.bestProject)), 160));
    if (student.selfTaught) out.push(truncate(toThirdPerson(stripLeadIn(student.selfTaught)), 160));
    return out;
  }

  /**
   * Splits the reviewer's validation reason into its own clean, specific
   * clauses (that person's actual words) instead of remapping it to a
   * small fixed dictionary of generic strength labels.
   */
  function validationInsights(student){
    var reason = (student.validationReason || "").trim();
    if (!reason) return [];
    var clauses = reason.split(/[,;]|(?:\s+and\s+)/i)
      .map(function(c){ return toThirdPerson(c.trim().replace(/^[-•]\s*/, "")); })
      .filter(function(c){ return c.length > 2; })
      .map(function(c){ return c.charAt(0).toUpperCase() + c.slice(1); });
    return clauses.length ? clauses : [toThirdPerson(reason)];
  }

  /**
   * Synchronous, fully local analysis for one student — no network call,
   * so nothing here can "silently fail" back to generic filler.
   */
  function computeStudentAnalysis(student){
    var facts = computeFactHighlights(student);
    return {
      summary: buildSummary(student, facts),
      highlights: facts,
      experienceBullets: experienceBullets(student),
      validationInsights: validationInsights(student),
      techCategories: categorizeStack(student.techStack),
      completenessPct: completeness(student),
      signalScore: signalScore(student),
      signalStars: signalStars(signalScore(student))
    };
  }


  function buildStudents(rawRows){
    const seenIds = {};
    return rawRows
      .filter(row => (row[NAME_KEY] || "").trim())
      .map(row => {
        const name = (row[NAME_KEY] || "").trim();
        const university = UNIVERSITY_KEY ? (row[UNIVERSITY_KEY] || "").trim() : "";

        // Stable id derived from name+university (not row index), so edits/reorders
        // in the sheet don't orphan existing shortlist data on refresh.
        let baseId = slug(name) + (university ? "-" + slug(university) : "");
        if (!baseId) baseId = "student";
        seenIds[baseId] = (seenIds[baseId] || 0) + 1;
        const id = seenIds[baseId] > 1 ? `${baseId}-${seenIds[baseId]}` : baseId;

        const links = [];      // { label, url, header }
        const contacts = [];   // { label, value }
        const longTexts = [];  // { label, value }
        const shortFields = []; // any other short non-empty fields
        const categories = []; // checkbox-style fields where the value just repeats the header

        RAW_HEADERS.forEach(header => {
          const raw = row[header];
          if (raw === undefined || raw === null) return;
          const value = String(raw).trim();
          if (!value) return;
          if (header === NAME_KEY) return;

          if (isUrl(value)) {
            links.push({ label: shortLinkLabel(header), url: value, header });
            return;
          }
          if (CONTACT_KEYS.includes(header)) {
            contacts.push({ label: header, value });
            return;
          }
          if (header === UNIVERSITY_KEY) return; // shown in header area already
          // Google Forms checkbox columns export the option text as both the header
          // and the cell value when ticked — surface those as tags, not "X: X" rows.
          if (value.toLowerCase() === header.trim().toLowerCase()) {
            categories.push(value);
            return;
          }
          if (value.length > 140) {
            longTexts.push({ label: cleanLongLabel(header), value });
            return;
          }
          shortFields.push({ label: header, value });
        });

        // Build a lookup so the analysis engine can find links by role regardless
        // of the exact header wording used for them.
        const linkByLabel = {};
        links.forEach(l => { if (!linkByLabel[l.label]) linkByLabel[l.label] = l.url; });

        const analysisInput = {
          name, university,
          program: PROGRAM_KEY ? (row[PROGRAM_KEY] || "").trim() : "",
          gradYear: GRADYEAR_KEY ? (row[GRADYEAR_KEY] || "").trim() : "",
          city: CITY_KEY ? (row[CITY_KEY] || "").trim() : "",
          categories,
          linkedin: linkByLabel["LinkedIn"] || "",
          github: linkByLabel["GitHub"] || "",
          portfolio: linkByLabel["Portfolio"] || "",
          resume: linkByLabel["Resume"] || "",
          introVideo: linkByLabel["Intro Video"] || "",
          repoLink: linkByLabel["Project Link"] || linkByLabel["Drive Link"] || "",
          techStack: TECHSTACK_KEY ? (row[TECHSTACK_KEY] || "").trim() : "",
          whyFellowship: WHY_KEY ? (row[WHY_KEY] || "").trim() : "",
          proudAchievement: PROUD_KEY ? (row[PROUD_KEY] || "").trim() : "",
          bestProject: BESTPROJECT_KEY ? (row[BESTPROJECT_KEY] || "").trim() : "",
          selfTaught: SELFTAUGHT_KEY ? (row[SELFTAUGHT_KEY] || "").trim() : "",
          repoExplain: REPOEXPLAIN_KEY ? (row[REPOEXPLAIN_KEY] || "").trim() : "",
          debugStory: DEBUG_KEY ? (row[DEBUG_KEY] || "").trim() : "",
          validationReason: VALIDATION_KEY ? (row[VALIDATION_KEY] || "").trim() : ""
        };

        const analysis = computeStudentAnalysis(analysisInput);

        return { id, name, university, links, contacts, longTexts, shortFields, categories, analysis };
      });
  }

  async function loadSheetData(){
    const [studentsTable, companiesTable] = await Promise.all([
      fetchTabViaJsonp(STUDENTS_TAB),
      fetchTabViaJsonp(COMPANIES_TAB)
    ]);

    const studentsParsed = tableToRows(studentsTable);
    const companiesParsed = tableToRows(companiesTable);

    RAW_HEADERS = studentsParsed.fields || [];
    const RAW_STUDENTS = studentsParsed.data;

    const companyHeaderKey = (companiesParsed.fields || [])[0];
    COMPANIES = companiesParsed.data
      .map(r => (r[companyHeaderKey] || "").trim())
      .filter(Boolean);

    NAME_KEY = findHeader(/full ?name|^name$/i) || RAW_HEADERS[0];
    UNIVERSITY_KEY = findHeader(/university|institute|college/i);
    EMAIL_KEY = findHeader(/email/i);
    PHONE_KEY = findHeader(/phone|mobile|contact number/i);
    // Don't include email and phone in contact display
    CONTACT_KEYS = [];

    PROGRAM_KEY = findHeader(/program|department|branch|major/i);
    GRADYEAR_KEY = findHeader(/grad(uation)? ?year/i);
    CITY_KEY = findHeader(/current city|^city$/i);
    TECHSTACK_KEY = findHeader(/tech ?stack/i);
    WHY_KEY = findHeader(/why.*(fellowship|polaris|apply)/i);
    PROUD_KEY = findHeader(/proud|achievement.*(impact|measurable)/i);
    BESTPROJECT_KEY = findHeader(/best project/i);
    SELFTAUGHT_KEY = findHeader(/taught yourself|self.?taught/i);
    REPOEXPLAIN_KEY = findHeader(/explain.*repo|repo.*explain|briefly explain/i);
    DEBUG_KEY = findHeader(/debug/i);
    VALIDATION_KEY = findHeader(/validation/i);

    STUDENTS = buildStudents(RAW_STUDENTS);
  }

  /* ---------------- Storage helpers (persistent, shared) ---------------- */
  const SHORTLIST_KEY = "polaris_r3_shortlists";
  const COMPANY_PREF_KEY = "polaris_r3_current_company";

  let shortlists = {}; // { studentId: [companyName, ...] }
  let currentCompany = null;

  async function loadShortlists(){
    try {
      const res = await window.storage.get(SHORTLIST_KEY, true);
      if (res && res.value) {
        shortlists = JSON.parse(res.value);
      }
    } catch (e) {
      shortlists = {};
    }
  }

  async function saveShortlists(){
    try {
      await window.storage.set(SHORTLIST_KEY, JSON.stringify(shortlists), true);
    } catch (e) {
      console.error("Could not save shortlists", e);
    }
  }

  async function loadCompanyPref(){
    try {
      const res = await window.storage.get(COMPANY_PREF_KEY, false);
      if (res && res.value && COMPANIES.includes(res.value)) {
        currentCompany = res.value;
        return true;
      }
    } catch (e) { /* no pref saved yet */ }
    return false;
  }

  async function saveCompanyPref(){
    try {
      await window.storage.set(COMPANY_PREF_KEY, currentCompany, false);
    } catch (e) { console.error("Could not save company pref", e); }
  }

  function shortlistersFor(studentId){
    return shortlists[studentId] || [];
  }

  async function toggleShortlist(studentId){
    if (!currentCompany) { showIdentityGate(); return; }
    const list = shortlists[studentId] || [];
    if (list.includes(currentCompany)) {
      shortlists[studentId] = list.filter(c => c !== currentCompany);
    } else {
      shortlists[studentId] = [...list, currentCompany];
    }
    await saveShortlists();
    renderAll();
  }

  /* ---------------- Rendering ---------------- */
  let activeStudentId = null;
  let searchQuery = "";
  let sortMode = "name";

  function medalFor(rank){
    if (rank === 0) return "🥇";
    if (rank === 1) return "🥈";
    if (rank === 2) return "🥉";
    return "🏅";
  }

  function renderCompanyGreeting(){
    const el = document.getElementById("company-greeting");
    if (!currentCompany) { el.innerHTML = ""; return; }
    el.innerHTML = `<span class="wave">👋</span> Hello, <b>${escapeHtml(titleCase(currentCompany))}</b> <button id="exit-btn" class="exit-link">Exit</button>`;
    const exitBtn = document.getElementById("exit-btn");
    if (exitBtn) exitBtn.addEventListener("click", exitCompany);
  }

  /**
   * Signs the current company out and shows the "who are you?" gate again.
   * Only clears which company is "logged in" on this browser — shortlist
   * data itself lives in shared storage and is never touched here, so if
   * the same company (or any other) picks up again later, their previous
   * choices are exactly as they left them.
   */
  async function exitCompany(){
    currentCompany = null;
    try { await window.storage.delete(COMPANY_PREF_KEY, false); } catch (e) { /* nothing to clear */ }
    renderAll();
    showIdentityGate();
  }

  /* ---------------- Identity gate + welcome toast ---------------- */
  function renderIdentityGrid(){
    const grid = document.getElementById("identity-grid");
    grid.innerHTML = COMPANIES.map(c => `
      <button class="identity-btn" data-company="${escapeHtml(c)}">
        <span class="id-avatar">${escapeHtml(initials(titleCase(c)))}</span>
        ${escapeHtml(titleCase(c))}
      </button>
    `).join("");
    grid.querySelectorAll(".identity-btn").forEach(btn => {
      btn.addEventListener("click", () => {
        chooseCompany(btn.getAttribute("data-company"));
      });
    });
  }

  function showIdentityGate(){
    document.getElementById("identity-overlay").classList.remove("hidden");
  }
  function hideIdentityGate(){
    document.getElementById("identity-overlay").classList.add("hidden");
  }

  /* ---------------- How-to-use popup ---------------- */
  const HOWTO_SEEN_KEY = "polaris_r3_howto_seen";

  function showHowTo(){
    document.getElementById("howto-overlay").classList.remove("hidden");
  }
  function hideHowTo(){
    document.getElementById("howto-overlay").classList.add("hidden");
  }
  async function markHowToSeen(){
    try { await window.storage.set(HOWTO_SEEN_KEY, "1", false); } catch (e) { /* ignore */ }
  }
  async function maybeShowHowToOnce(){
    let seen = false;
    try {
      const res = await window.storage.get(HOWTO_SEEN_KEY, false);
      seen = !!(res && res.value === "1");
    } catch (e) { seen = false; }
    if (!seen) showHowTo();
  }

  document.getElementById("help-fab").addEventListener("click", showHowTo);
  document.getElementById("howto-close").addEventListener("click", () => {
    hideHowTo();
    markHowToSeen();
  });

  let toastTimer = null;
  function showWelcomeToast(company, isWelcomeBack){
    const toast = document.getElementById("welcome-toast");
    const text = document.getElementById("welcome-toast-text");
    text.textContent = `${isWelcomeBack ? "Welcome back" : "Welcome"}, ${titleCase(company)}!`;
    toast.classList.add("show");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => toast.classList.remove("show"), 2400);
  }

  async function chooseCompany(company){
    currentCompany = company;
    await saveCompanyPref();
    hideIdentityGate();
    showWelcomeToast(company, false);
    renderAll();
    maybeShowHowToOnce();
  }

  function getFilteredSortedStudents(){
    let list = STUDENTS.slice();
    const q = searchQuery.trim().toLowerCase();
    if (q) {
      list = list.filter(s => {
        const haystack = [
          s.name, s.university,
          ...s.shortFields.map(f => f.value),
          ...s.longTexts.map(f => f.value),
          ...(s.categories || [])
        ].join(" ").toLowerCase();
        return haystack.includes(q);
      });
    }
    if (sortMode === "name") {
      list.sort((a, b) => a.name.localeCompare(b.name));
    } else if (sortMode === "university") {
      list.sort((a, b) => (a.university || "").localeCompare(b.university || ""));
    } else if (sortMode === "shortlists") {
      list.sort((a, b) => shortlistersFor(b.id).length - shortlistersFor(a.id).length || a.name.localeCompare(b.name));
    }
    return list;
  }

  function renderTable(){
    const table = document.getElementById("shortlist-table");
    const countSub = document.getElementById("student-count-sub");
    const list = getFilteredSortedStudents();
    countSub.textContent = `${list.length} of ${STUDENTS.length} candidates`;

    const theadRow = `
      <tr>
        <th class="name-col">Name / Company →</th>
        ${COMPANIES.map(c => `<th class="${c === currentCompany ? "me-col" : ""}">${escapeHtml(titleCase(c))}</th>`).join("")}
      </tr>
    `;

    if (list.length === 0) {
      table.innerHTML = `
        <thead>${theadRow}</thead>
        <tbody><tr><td class="table-no-results" colspan="${COMPANIES.length + 1}">No candidates match your search.</td></tr></tbody>
      `;
      return;
    }

    const maxCount = Math.max(0, ...STUDENTS.map(s => shortlistersFor(s.id).length));

    const bodyRows = list.map(s => {
      const shortlisters = shortlistersFor(s.id);
      const isTop = maxCount > 0 && shortlisters.length === maxCount;
      const cells = COMPANIES.map(c => {
        const checked = shortlisters.includes(c);
        const isMe = c === currentCompany;
        const classes = ["check-cell"];
        if (isMe) classes.push("me-col");
        if (checked) classes.push("checked");
        if (isMe) classes.push("clickable");
        let title = "";
        if (isMe) title = checked ? `Remove ${s.name} from your shortlist` : `Shortlist ${s.name}`;
        return `<td class="${classes.join(" ")}" data-id="${s.id}" data-company="${escapeHtml(c)}" ${title ? `title="${escapeHtml(title)}"` : ""}>${checked ? '<span class="check-mark">✓</span>' : ""}</td>`;
      }).join("");
      const pageLink = `candidate-dossier-${slug(s.name)}.html`;
      return `<tr class="${isTop ? "gold-row" : ""}"><td class="name-col" data-id="${s.id}"><a class="candidate-link" href="${escapeHtml(pageLink)}">${escapeHtml(s.name)}</a></td>${cells}</tr>`;
    }).join("");

    table.innerHTML = `<thead>${theadRow}</thead><tbody>${bodyRows}</tbody>`;

    table.querySelectorAll("td.name-col").forEach(cell => {
      cell.addEventListener("click", (e) => {
        if (e.target.closest("a")) return;
        openDossier(cell.getAttribute("data-id"));
      });
    });
    table.querySelectorAll("td.check-cell.clickable").forEach(cell => {
      cell.addEventListener("click", async () => {
        await toggleShortlist(cell.getAttribute("data-id"));
      });
    });
  }

  function renderDossier(){
    const overlay = document.getElementById("overlay");
    const panel = document.getElementById("dossier");
    if (!activeStudentId) {
      overlay.classList.remove("open");
      return;
    }
    const s = STUDENTS.find(x => x.id === activeStudentId);
    if (!s) { overlay.classList.remove("open"); return; }

    const shortlisters = shortlistersFor(s.id);
    const alreadyDone = currentCompany ? shortlisters.includes(currentCompany) : false;

    const contactRows = s.contacts.map(c => `
      <div class="contact-row"><span class="k">${escapeHtml(c.label)}</span><span class="v">${escapeHtml(c.value)}</span></div>
    `).join("");

    const shortFieldRows = s.shortFields.map(f => `
      <div class="contact-row"><span class="k">${escapeHtml(f.label)}</span><span class="v">${escapeHtml(f.value)}</span></div>
    `).join("");

    const linkButtons = s.links.map(l => `
      <a class="link-btn" href="${escapeHtml(l.url)}" target="_blank" rel="noopener noreferrer">
        ${escapeHtml(l.label)} <span class="arrow">↗</span>
      </a>
    `).join("");

    const a = s.analysis || {};

    const categoryChips = (s.categories || []).map(c => `<span class="tag-chip focus-chip">${escapeHtml(c)}</span>`).join("");

    const highlightItems = (a.highlights || []).map(h => `
      <div class="highlight-item">
        <span class="highlight-icon">${h.icon || "✦"}</span>
        <span class="highlight-text">${escapeHtml(h.text)}</span>
      </div>
    `).join("");

    const experienceItems = (a.experienceBullets || []).map(b => `<li>${escapeHtml(b)}</li>`).join("");

    const validationChips = (a.validationInsights || []).map(v => `<span class="tag-chip insight-chip">${escapeHtml(v)}</span>`).join("");

    const skillGroups = Object.entries(a.techCategories || {})
      .filter(([, items]) => items && items.length)
      .map(([cat, items]) => `
        <div class="skill-group">
          <span class="skill-group-label">${escapeHtml(cat)}</span>
          <div class="skill-chips">${items.map(i => `<span class="tag-chip skill-chip">${escapeHtml(i)}</span>`).join("")}</div>
        </div>
      `).join("");

    panel.innerHTML = `
      <div class="dossier-head">
        <button class="dossier-close" id="dossier-close">✕</button>
        <div class="dossier-head-inner">
          <p class="dossier-eyebrow">Candidate Dossier</p>
          <p class="dossier-name">${escapeHtml(s.name)}</p>
          ${s.university ? `<p class="dossier-uni">${escapeHtml(s.university)}</p>` : ""}
        </div>
      </div>
      <div class="dossier-body">

        <div class="dossier-shortlist-box">
          <div class="dossier-shortlist-top">
            <span class="mono" style="font-size:12px;color:var(--ink-soft);">
              ${shortlisters.length > 0 ? `Shortlisted by ${shortlisters.length} compan${shortlisters.length === 1 ? "y" : "ies"}` : "Not shortlisted yet"}
            </span>
            <button class="shortlist-btn ${alreadyDone ? "shortlisted" : ""}" id="dossier-shortlist-btn">
              ${alreadyDone ? "✓ Shortlisted — click to remove" : (currentCompany ? `Shortlist as ${escapeHtml(titleCase(currentCompany))}` : "Shortlist")}
            </button>
          </div>
          ${shortlisters.length > 0 ? `<div class="companies-list"><b>Companies:</b> ${shortlisters.map(c => escapeHtml(titleCase(c))).join(", ")}</div>` : ""}
        </div>

        ${(contactRows || shortFieldRows) ? `
        <div class="field-group">
          <h3>Contact & Details</h3>
          <div class="contact-rows">${contactRows}${shortFieldRows}</div>
        </div>` : ""}

        ${linkButtons ? `
        <div class="field-group">
          <h3>Links</h3>
          <div class="link-buttons">${linkButtons}</div>
        </div>` : ""}

        ${a.summary ? `
        <div class="field-group">
          <h3>Professional Summary</h3>
          <p class="summary-text">${escapeHtml(a.summary)}</p>
          ${categoryChips ? `<div class="tag-row" style="margin-top:10px;">${categoryChips}</div>` : ""}
        </div>` : ""}

        ${highlightItems ? `
        <div class="field-group">
          <h3>Key Highlights</h3>
          <div class="highlight-list">${highlightItems}</div>
        </div>` : ""}

        ${skillGroups ? `
        <div class="field-group">
          <h3>Technical Skills</h3>
          <div class="skill-groups">${skillGroups}</div>
        </div>` : ""}

        ${experienceItems ? `
        <div class="field-group">
          <h3>Experience Summary</h3>
          <ul class="experience-list">${experienceItems}</ul>
        </div>` : ""}

      </div>
    `;

    document.getElementById("dossier-close").addEventListener("click", closeDossier);
    const dBtn = document.getElementById("dossier-shortlist-btn");
    if (dBtn) {
      dBtn.addEventListener("click", async () => {
        await toggleShortlist(s.id);
      });
    }

    overlay.classList.add("open");
  }

  function openDossier(id){
    activeStudentId = id;
    renderDossier();
    document.body.style.overflow = "hidden";
  }
  function closeDossier(){
    activeStudentId = null;
    renderDossier();
    document.body.style.overflow = "";
  }

  document.getElementById("overlay").addEventListener("click", (e) => {
    if (e.target.id === "overlay") closeDossier();
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") closeDossier();
  });

  document.getElementById("search-input").addEventListener("input", (e) => {
    searchQuery = e.target.value;
    renderTable();
  });
  document.getElementById("sort-select").addEventListener("change", (e) => {
    sortMode = e.target.value;
    renderTable();
  });

  function renderAll(){
    renderCompanyGreeting();
    renderTable();
    if (activeStudentId) renderDossier();
  }

  /* ---------------- Live sync polling (so other companies' actions show up) ---------------- */
  async function pollShortlists(){
    try {
      const res = await window.storage.get(SHORTLIST_KEY, true);
      const latest = res && res.value ? JSON.parse(res.value) : {};
      if (JSON.stringify(latest) !== JSON.stringify(shortlists)) {
        shortlists = latest;
        renderAll();
      }
    } catch (e) { /* key may not exist yet */ }
  }

  async function pollSheetData(){
    // Pick up edits made directly in the Google Sheet (new students, new companies, edited fields).
    try {
      const prevCompanies = JSON.stringify(COMPANIES);
      const prevStudentCount = STUDENTS.length;
      await loadSheetData();
      if (JSON.stringify(COMPANIES) !== prevCompanies || STUDENTS.length !== prevStudentCount) {
        renderAll();
      } else {
        renderTable(); // cheap re-render in case field values changed
      }
    } catch (e) { /* sheet temporarily unreachable — keep showing last good data */ }
  }

  function showLoadError(message){
    document.getElementById("loading-screen").innerHTML = `
      <div style="max-width:420px; text-align:center; padding:0 20px;">
        <p style="font-family:'JetBrains Mono',monospace; font-size:12.5px; color:#E8A33D; margin:0 0 10px; letter-spacing:0.05em; text-transform:uppercase;">Couldn't load your data</p>
        <p style="font-size:14px; color: rgba(247,245,239,0.8); line-height:1.6; margin:0 0 20px;">${escapeHtml(message)}<br><br>Double-check that the tabs in your Google Sheet are named exactly "Students" and "Companies" (case-sensitive), then try again. If it keeps failing, you may be offline.</p>
        <button id="retry-load" style="font-family:'Inter',sans-serif; font-weight:600; font-size:13px; padding:10px 18px; border-radius:9px; border:none; cursor:pointer; background:#E8A33D; color:#12172B;">Try again</button>
      </div>
    `;
    document.getElementById("retry-load").addEventListener("click", () => {
      document.getElementById("loading-screen").innerHTML = `<div class="spinner"></div><p>RETRYING…</p>`;
      document.getElementById("loading-screen").style.display = "flex";
      init();
    });
  }

  /* ---------------- Init ---------------- */
  async function init(){
    try {
      await loadSheetData();
    } catch (e) {
      showLoadError(e.message || "Something went wrong reaching the sheet.");
      return;
    }
    renderIdentityGrid();
    await Promise.all([loadShortlists(), loadCompanyPref()]);
    renderAll();
    document.getElementById("loading-screen").style.display = "none";
    if (currentCompany) {
      showWelcomeToast(currentCompany, true);
      maybeShowHowToOnce();
    } else {
      showIdentityGate();
    }
    setInterval(pollShortlists, 4000);
    setInterval(pollSheetData, REFRESH_MS);
  }

  init();
})();
