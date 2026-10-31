// Last-resort page when the browser has evicted every cached shell.
const OFFLINE_FALLBACK_HTML = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>everydashcam</title><style>html,body{margin:0;height:100%;background:#0a0a0a;color:#f5f4f1;font:16px/1.5 system-ui,-apple-system,sans-serif;display:flex;align-items:center;justify-content:center;text-align:center}.dc-b{max-width:30rem;padding:2rem}h1{color:#ff9000;font-size:1.25rem;margin:0 0 .75rem}p{margin:0 0 1.5rem;color:#bdbdbd}button{background:#ff9000;color:#000;border:0;border-radius:.5rem;padding:.75rem 1.5rem;font:inherit;font-weight:600;cursor:pointer}</style></head><body><div class="dc-b"><h1 id="dc-t"></h1><p id="dc-m"></p><button id="dc-r"></button></div><script>(function(){var ru=(navigator.language||"").toLowerCase().indexOf("ru")===0;document.getElementById("dc-t").textContent=ru?"Нет интернета":"You're offline";document.getElementById("dc-m").textContent=ru?"Сохранённой копии приложения сейчас нет на устройстве. Подключитесь к интернету один раз — и она восстановится сама.":"The saved copy of the app isn't on this device right now. Connect to the internet once and it will restore itself.";var b=document.getElementById("dc-r");b.textContent=ru?"Повторить":"Retry";b.onclick=function(){location.reload()};addEventListener("online",function(){location.reload()})})()</script></body></html>`;

export function offlineResponse(): Response {
    return new Response(OFFLINE_FALLBACK_HTML, {
        status: 503,
        headers: { "content-type": "text/html; charset=utf-8" },
    });
}
