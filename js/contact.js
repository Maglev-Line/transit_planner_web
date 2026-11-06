/* 页脚联系卡片：鼠标悬停、点击与键盘均可打开。 */
(() => {
  "use strict";

  const contact = document.getElementById("contact");
  if (!contact) return;

  const button = document.getElementById("btn-contact");
  const copyLabel = document.getElementById("wechat-copy");
  const wechat = document.getElementById("contact-wechat");
  const toast = (message) => {
    const el = document.getElementById("toast") || document.getElementById("rec-toast");
    if (!el) return;
    el.textContent = message;
    el.hidden = false;
    clearTimeout(toast.timer);
    toast.timer = setTimeout(() => { el.hidden = true; }, 2200);
  };

  async function copyText(text) {
    try {
      if (navigator.clipboard && window.isSecureContext) {
        await navigator.clipboard.writeText(text);
        return true;
      }
    } catch { /* 无权限时走降级方案 */ }
    const area = document.createElement("textarea");
    area.value = text;
    area.setAttribute("readonly", "");
    area.style.position = "fixed";
    area.style.top = "-1000px";
    document.body.appendChild(area);
    area.select();
    const copied = document.execCommand("copy");
    area.remove();
    return copied;
  }

  button.addEventListener("click", (event) => {
    event.stopPropagation();
    const open = contact.classList.toggle("open");
    button.setAttribute("aria-expanded", String(open));
  });
  document.addEventListener("click", (event) => {
    if (!event.target.closest(".contact")) {
      contact.classList.remove("open");
      button.setAttribute("aria-expanded", "false");
    }
  });
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
      contact.classList.remove("open");
      button.setAttribute("aria-expanded", "false");
    }
  });
  wechat.addEventListener("click", async () => {
    const copied = await copyText("francal2010");
    copyLabel.innerHTML = copied
      ? '已复制 <span class="ico ico-mono" style="--icon:url(assets/icons/check.svg)" aria-hidden="true"></span>'
      : "复制失败";
    wechat.classList.toggle("copied", copied);
    toast(copied ? "微信号 francal2010 已复制到剪贴板" : "复制失败，请手动记录：francal2010");
    setTimeout(() => {
      copyLabel.textContent = "复制";
      wechat.classList.remove("copied");
    }, 2000);
  });
})();
