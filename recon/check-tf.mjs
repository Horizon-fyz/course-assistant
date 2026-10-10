import { readFileSync } from "node:fs";
const data = JSON.parse(readFileSync("K:\\网页自动学习\\export\\papers.json", "utf8"));
const qs = [];
for (const items of Object.values(data))
  for (const it of items)
    for (const p of it.paper?.rt?.examBase?.workExamParts ?? [])
      for (const q of p.questionDtos ?? []) qs.push(q);
for (const t of ["单选题","多选题","判断题"]) {
  const q = qs.find(x => x.questionType?.name === t);
  console.log("=== " + t + " ===");
  console.log("题干:", JSON.stringify(q.name));
  console.log("分值:", q.questionScore);
  console.log("选项:", JSON.stringify(q.questionOptions.map(o=>o.content)));
  console.log();
}
// 检查判断题选项是否固定为 正确/错误
const tf = qs.filter(x=>x.questionType?.name==="判断题");
const sets = new Map();
for(const q of tf){ const k = q.questionOptions.map(o=>o.content).join("|"); sets.set(k,(sets.get(k)??0)+1); }
console.log("判断题选项组合分布:");
for(const [k,v] of sets) console.log("  " + v + " 题: " + k);
// 题干里是否有富文本标签
const html = qs.filter(x=>/<[a-zA-Z/]/.test(x.name||""));
console.log("\n题干含 HTML 标签的题数:", html.length);
if(html.length) console.log("  例:", JSON.stringify(html[0].name).slice(0,200));
