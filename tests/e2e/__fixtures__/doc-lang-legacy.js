// Minimal lang-switcher shared by the standalone doc pages (privacy.html,
// add-my-camera.html, terms.html, 404.html), no framework. External file (not inline)
// to keep CSP script-src clean.
//
// Initial pick: ?lang= > URL path > saved doc/app language > browser language > en.
// Supported languages match the app (see src/i18n/index.ts LANGS). EN+RU are
// first-class; the other 8 are community translations with an EN-prevails
// disclaimer at the top of each article.
(function () {
    var STORE_KEY = "everydashcam:doc-lang";
    var SUPPORTED = ["de", "en", "es", "fr", "ja", "ko", "pl", "pt", "ru", "zh"];

    function isSupported(code) {
        for (var i = 0; i < SUPPORTED.length; i++) {
            if (SUPPORTED[i] === code) return true;
        }
        return false;
    }

    function setLang(code) {
        if (!isSupported(code)) return;
        var articles = document.querySelectorAll("article[data-lang]");
        for (var i = 0; i < articles.length; i++) {
            articles[i].hidden = articles[i].getAttribute("data-lang") !== code;
        }
        var btns = document.querySelectorAll(".lang-switcher button");
        for (var j = 0; j < btns.length; j++) {
            var active = btns[j].getAttribute("data-set-lang") === code;
            btns[j].classList.toggle("active", active);
            btns[j].setAttribute("aria-selected", active ? "true" : "false");
        }
        document.documentElement.lang = code;
        var homeLinks = document.querySelectorAll("[data-locale-home]");
        for (var k = 0; k < homeLinks.length; k++) {
            homeLinks[k].setAttribute("href", "/" + code + "/");
        }
        try { localStorage.setItem(STORE_KEY, code); } catch (e) { /* private mode */ }
    }

    function pickInitial() {
        // URL ?lang= wins: the EN-prevails links inside non-EN articles point to
        // ?lang=en so the user can jump to the master version regardless of a
        // persisted choice.
        try {
            var params = new URLSearchParams(window.location.search);
            var fromUrl = params.get("lang");
            if (fromUrl && isSupported(fromUrl)) return fromUrl;
        } catch (e) { /* malformed URL */ }
        var fromPath = window.location.pathname.split("/")[1];
        if (fromPath && isSupported(fromPath)) return fromPath;
        try {
            var stored = localStorage.getItem(STORE_KEY);
            if (stored && isSupported(stored)) return stored;
            var appLang = localStorage.getItem("everydashcam:lang");
            if (appLang && isSupported(appLang)) return appLang;
        } catch (e) { /* private mode */ }
        var nav = (navigator.language || "").toLowerCase().split("-")[0];
        if (isSupported(nav)) return nav;
        return "en";
    }

    setLang(pickInitial());

    var btns = document.querySelectorAll(".lang-switcher button");
    for (var i = 0; i < btns.length; i++) {
        btns[i].addEventListener("click", function (ev) {
            setLang(ev.currentTarget.getAttribute("data-set-lang"));
        });
    }
})();
