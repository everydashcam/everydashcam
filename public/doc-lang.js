// Standalone document routes select one published language. Legacy document
// URLs redirect on the current host; 404 keeps its in-page language switcher.
(function () {
    var STORE_KEY = "everydashcam:doc-lang";
    var root = document.documentElement;
    var slug = root.getAttribute("data-doc-slug");
    var published = root.getAttribute("data-doc-locales");
    var SUPPORTED = published ? published.split(",") : ["de", "en", "es", "fr", "ja", "ko", "pl", "pt", "ru", "zh"];

    function isSupported(code) {
        for (var i = 0; i < SUPPORTED.length; i++) {
            if (SUPPORTED[i] === code) return true;
        }
        return false;
    }

    function saveLang(code) {
        try { localStorage.setItem(STORE_KEY, code); } catch (e) { /* private mode */ }
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
        root.lang = code;
        var homeLinks = document.querySelectorAll("[data-locale-home]");
        for (var k = 0; k < homeLinks.length; k++) {
            homeLinks[k].setAttribute("href", "/" + code + "/");
        }
        saveLang(code);
    }

    function pickInitial() {
        // An explicit path is share-safe, even with a conflicting old query.
        var fromPath = window.location.pathname.split("/")[1];
        if (fromPath && isSupported(fromPath)) return fromPath;
        try {
            var params = new URLSearchParams(window.location.search);
            var fromUrl = params.get("lang");
            if (fromUrl && isSupported(fromUrl)) return fromUrl;
        } catch (e) { /* malformed URL */ }
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

    var initial = pickInitial();
    if (slug) {
        saveLang(initial);
        if (root.getAttribute("data-doc-redirect") === "true") {
            var params = new URLSearchParams(window.location.search);
            params.delete("lang");
            var query = params.toString();
            window.location.replace("/" + initial + "/" + slug + "/" + (query ? "?" + query : "") + window.location.hash);
            return;
        }
        var links = document.querySelectorAll(".lang-switcher a[data-set-lang]");
        for (var j = 0; j < links.length; j++) {
            links[j].addEventListener("click", function (ev) {
                saveLang(ev.currentTarget.getAttribute("data-set-lang"));
            });
        }
        return;
    }

    setLang(initial);
    var btns = document.querySelectorAll(".lang-switcher button");
    for (var i = 0; i < btns.length; i++) {
        btns[i].addEventListener("click", function (ev) {
            setLang(ev.currentTarget.getAttribute("data-set-lang"));
        });
    }
})();
