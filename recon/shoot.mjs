import { chromium } from "playwright";
const b = await chromium.launch({ channel: "msedge", headless: true });
const p = await b.newPage({ viewport: { width: 1100, height: 1400 }, deviceScaleFactor: 1.5 });
await p.goto("file:///K:/网页自动学习/export/智慧树作业题库_打印预览.html", { waitUntil: "load" });
await p.waitForTimeout(1000);
await p.screenshot({ path: "K:\\网页自动学习\\export\\preview-top.png" });
// 滚到第一门课正文
await p.evaluate(() => { const el=[...document.querySelectorAll("h1")][0]; if(el) el.scrollIntoView(); });
await p.waitForTimeout(400);
await p.screenshot({ path: "K:\\网页自动学习\\export\\preview-course.png" });
// 目录区
await p.evaluate(() => window.scrollTo(0, 0));
await p.waitForTimeout(300);
await p.screenshot({ path: "K:\\网页自动学习\\export\\preview-cover-toc.png", fullPage: false });
console.log("screenshots done");
await b.close();
