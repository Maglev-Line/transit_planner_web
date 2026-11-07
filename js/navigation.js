/* 页面间的来源上下文：让数据工坊与审核台返回到实际的上一页。 */
(() => {
  "use strict";

  const pages = {
    home: { href: "index.html", label: "首页" },
    plan: { href: "plan.html", label: "规划模式" },
    record: { href: "record.html", label: "记录模式" },
    editor: { href: "editor.html", label: "线路数据工坊" },
    review: { href: "review.html", label: "数据审核台" },
  };
  const currentPage = document.body.dataset.page;
  const requestedSource = new URLSearchParams(location.search).get("from");
  const source = pages[requestedSource] && requestedSource !== currentPage ? requestedSource : "home";

  const backLink = document.querySelector("[data-page-back]");
  if (backLink) {
    backLink.href = pages[source].href;
    backLink.textContent = `← 返回${pages[source].label}`;
    backLink.title = `返回${pages[source].label}`;
  }

  document.querySelectorAll("[data-page-link]").forEach((link) => {
    const target = pages[link.dataset.pageLink];
    if (!target) return;
    const url = new URL(target.href, location.href);
    url.searchParams.set("from", currentPage);
    link.href = `${url.pathname.split("/").pop()}${url.search}${url.hash}`;
  });
})();
