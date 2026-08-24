import { describe, expect, test } from "bun:test";
import { HappyworkError } from "../src/core/errors.ts";
import type { PdfMeta } from "../src/infra/pdf/meta.ts";
import { planSplit, resolveChapters, type Chapter, type SplitPlan } from "../src/infra/pdf/plan.ts";

/** 构造 meta：pages 页，每页 bytesPerPage 字节，印刷页 offset */
function meta(pages: number, bytesPerPage = 1000, offset: number | null = 7): PdfMeta {
  return {
    path: "/tmp/x.pdf",
    sha256: "0".repeat(64),
    bytes: pages * bytesPerPage,
    pages,
    textLayer: { present: false, fonts: 0, toUnicode: 0, imagePages: pages },
    labels: offset === null ? [] : [{ startPage: offset + 1, style: "D", start: 1 }],
    offset,
    pageMetas: Array.from({ length: pages }, (_, i) => ({
      index: i,
      images: [],
      fonts: 0,
      bytes: bytesPerPage,
    })),
  };
}

/** 各分片的基准区间必须无重不漏地覆盖全书 */
function assertCoversExactly(plan: SplitPlan, total: number) {
  expect(plan.chunks.length).toBeGreaterThan(0);
  expect(plan.chunks[0]!.baseStart).toBe(0);
  expect(plan.chunks.at(-1)!.srcEnd).toBe(total - 1);
  let sum = 0;
  for (let i = 0; i < plan.chunks.length; i++) {
    const c = plan.chunks[i]!;
    expect(c.srcEnd).toBeGreaterThanOrEqual(c.baseStart);
    sum += c.srcEnd - c.baseStart + 1;
    if (i > 0) expect(c.baseStart).toBe(plan.chunks[i - 1]!.srcEnd + 1);
  }
  expect(sum).toBe(total);
}

const OPTS = { maxPages: 200, maxBytes: 190_000_000, overlap: 0 };

describe("页数上限切分", () => {
  test("266 页 / 上限 200 → 2 片，无重不漏", () => {
    const p = planSplit(meta(266), OPTS);
    expect(p.chunks).toHaveLength(2);
    assertCoversExactly(p, 266);
    for (const c of p.chunks) expect(c.pages).toBeLessThanOrEqual(200);
  });

  test("页数之和等于总页数", () => {
    const p = planSplit(meta(266), OPTS);
    expect(p.chunks.reduce((s, c) => s + c.pages, 0)).toBe(266);
  });

  test("无需拆分时产出单个分片", () => {
    const p = planSplit(meta(120), OPTS);
    expect(p.chunks).toHaveLength(1);
    expect(p.chunks[0]).toMatchObject({ srcStart: 0, srcEnd: 119, pages: 120 });
  });

  test("恰好等于上限：不拆", () => {
    const p = planSplit(meta(200), OPTS);
    expect(p.chunks).toHaveLength(1);
  });

  test("刚好超过上限一页：拆成 2 片", () => {
    const p = planSplit(meta(201), OPTS);
    expect(p.chunks).toHaveLength(2);
    expect(p.chunks[0]!.pages).toBe(200);
    expect(p.chunks[1]!.pages).toBe(1);
  });

  test("单页文档", () => {
    const p = planSplit(meta(1), OPTS);
    expect(p.chunks).toHaveLength(1);
    assertCoversExactly(p, 1);
  });

  test("maxPages=1 时每页一片", () => {
    const p = planSplit(meta(5), { ...OPTS, maxPages: 1 });
    expect(p.chunks).toHaveLength(5);
    assertCoversExactly(p, 5);
  });
});

describe("体积上限", () => {
  test("体积先于页数触发细分", () => {
    // 100 页 × 10MB = 1000MB，上限 190MB → 每片最多 19 页
    const p = planSplit(meta(100, 10_000_000), { ...OPTS, maxBytes: 190_000_000 });
    for (const c of p.chunks) expect(c.estBytes).toBeLessThanOrEqual(190_000_000);
    expect(p.chunks.length).toBeGreaterThan(1);
    assertCoversExactly(p, 100);
  });

  test("两个上限同时生效，取更严的那个", () => {
    const p = planSplit(meta(100, 10_000_000), { ...OPTS, maxPages: 50, maxBytes: 190_000_000 });
    for (const c of p.chunks) {
      expect(c.pages).toBeLessThanOrEqual(50);
      expect(c.estBytes).toBeLessThanOrEqual(190_000_000);
    }
  });

  test("单页即超过体积上限：报错并指出页号", () => {
    const m = meta(10, 1000);
    m.pageMetas[4]!.bytes = 500_000_000;
    expect(() => planSplit(m, OPTS)).toThrow(HappyworkError);
    try {
      planSplit(m, OPTS);
    } catch (e) {
      const err = e as HappyworkError;
      expect(err.code).toBe("page-exceeds-max-bytes");
      expect(err.details["page"]).toBe("4");
    }
  });
});

describe("章节对齐", () => {
  // 样本书真实章节表（探索阶段自目录读出，印刷页）
  const CHAPTERS: Chapter[] = [
    { number: 1, title: "晨星公司从事股票研究的指导原则", printedStart: 1 },
    { number: 2, title: "护城河的 5 项来源", printedStart: 13 },
    { number: 3, title: "护城河趋势", printedStart: 37 },
    { number: 4, title: "管理对经济护城河的影响", printedStart: 65 },
    { number: 5, title: "护城河在红利型投资中的应用", printedStart: 89 },
    { number: 6, title: "公允价值的评估", printedStart: 103 },
    { number: 7, title: "护城河评级可用来预测股票收益率吗", printedStart: 125 },
    { number: 8, title: "护城河与估值的结合运用：投资组合策略", printedStart: 135 },
    { number: 9, title: "基础材料业", printedStart: 147 },
    { number: 10, title: "消费品业", printedStart: 159 },
    { number: 11, title: "能源业", printedStart: 175 },
  ];

  test("拆分点落在章首：266 页 / 上限 200 → [0,141] + [142,265]", () => {
    const p = planSplit(meta(266), { ...OPTS, chapters: CHAPTERS });
    expect(p.chunks).toHaveLength(2);
    expect(p.chunks[0]).toMatchObject({ srcStart: 0, srcEnd: 141, pages: 142 });
    expect(p.chunks[1]).toMatchObject({ srcStart: 142, srcEnd: 265, pages: 124 });
    expect(p.warnings).toHaveLength(0);
    assertCoversExactly(p, 266);
  });

  test("每个拆分点都是某一章的起始页", () => {
    const p = planSplit(meta(266), { ...OPTS, chapters: CHAPTERS });
    const starts = new Set(CHAPTERS.map((c) => c.printedStart! + 7));
    for (const c of p.chunks.slice(1)) expect(starts.has(c.baseStart)).toBe(true);
  });

  test("印刷页区间换算正确", () => {
    const p = planSplit(meta(266), { ...OPTS, chapters: CHAPTERS });
    expect(p.chunks[1]!.printedStart).toBe(135);
    expect(p.chunks[1]!.printedEnd).toBe(258);
    expect(p.chunks[0]!.printedStart).toBeNull(); // 第 0 页在正文之前
    expect(p.chunks[0]!.printedEnd).toBe(134);
  });

  test("无 offset 时印刷页区间为 null，拆分照常", () => {
    const p = planSplit(meta(266, 1000, null), {
      ...OPTS,
      chapters: [{ title: "一", srcStart: 0 }, { title: "二", srcStart: 142 }],
    });
    expect(p.chunks[0]!.printedStart).toBeNull();
    expect(p.chunks[0]!.printedEnd).toBeNull();
    assertCoversExactly(p, 266);
  });

  test("单章超过上限：章内退让为按页切分并产出警告", () => {
    const p = planSplit(meta(300), {
      ...OPTS,
      maxPages: 100,
      chapters: [{ title: "巨章", srcStart: 0 }, { title: "小章", srcStart: 250 }],
    });
    expect(p.warnings.join()).toContain("巨章");
    expect(p.warnings.join()).toContain("退让");
    for (const c of p.chunks) expect(c.pages).toBeLessThanOrEqual(100);
    assertCoversExactly(p, 300);
  });

  test("章节表按起始页排序，输入乱序也可", () => {
    const r = resolveChapters(
      [{ title: "三", srcStart: 20 }, { title: "一", srcStart: 0 }, { title: "二", srcStart: 10 }],
      meta(30),
    );
    expect(r.map((c) => c.srcStart)).toEqual([0, 10, 20]);
  });
});

describe("章节表校验", () => {
  test("空章节表报错", () => {
    expect(() => resolveChapters([], meta(10))).toThrow(HappyworkError);
  });

  test("起始页越界报错", () => {
    expect(() => resolveChapters([{ title: "x", srcStart: 999 }], meta(10))).toThrow(
      HappyworkError,
    );
    try {
      resolveChapters([{ title: "x", srcStart: 999 }], meta(10));
    } catch (e) {
      expect((e as HappyworkError).code).toBe("invalid-chapters");
    }
  });

  test("缺少 printedStart 与 srcStart 报错", () => {
    expect(() => resolveChapters([{ title: "x" }], meta(10))).toThrow(HappyworkError);
  });

  test("使用 printedStart 但 PDF 无 PageLabels：报错并提示改用 srcStart", () => {
    try {
      resolveChapters([{ title: "x", printedStart: 1 }], meta(10, 1000, null));
      expect.unreachable();
    } catch (e) {
      expect((e as HappyworkError).message).toContain("srcStart");
    }
  });

  test("两章起始于同一页报错", () => {
    expect(() =>
      resolveChapters([{ title: "a", srcStart: 5 }, { title: "b", srcStart: 5 }], meta(10)),
    ).toThrow(HappyworkError);
  });
});

describe("重叠页", () => {
  test("除首片外每片向前多含 n 页，并标出重叠", () => {
    const p = planSplit(meta(266), { ...OPTS, overlap: 1 });
    expect(p.chunks[0]!.overlapPages).toBe(0);
    for (const c of p.chunks.slice(1)) {
      expect(c.overlapPages).toBe(1);
      expect(c.srcStart).toBe(c.baseStart - 1);
    }
    assertCoversExactly(p, 266); // 基准区间仍无重不漏
  });

  test("重叠页计入页数上限，不会撑破", () => {
    const p = planSplit(meta(266), { ...OPTS, maxPages: 200, overlap: 5 });
    for (const c of p.chunks) expect(c.pages).toBeLessThanOrEqual(200);
  });

  test("章节对齐 + 重叠：起点前移但基准边界仍在章首", () => {
    const p = planSplit(meta(266), {
      ...OPTS,
      overlap: 2,
      chapters: [{ title: "一", srcStart: 0 }, { title: "八", srcStart: 142 }],
    });
    expect(p.chunks[1]!.baseStart).toBe(142);
    expect(p.chunks[1]!.srcStart).toBe(140);
    expect(p.chunks[1]!.overlapPages).toBe(2);
  });

  test("overlap ≥ maxPages 报错", () => {
    expect(() => planSplit(meta(10), { ...OPTS, maxPages: 3, overlap: 3 })).toThrow(
      HappyworkError,
    );
  });

  test("负 overlap 与 maxPages<1 报错", () => {
    expect(() => planSplit(meta(10), { ...OPTS, overlap: -1 })).toThrow(HappyworkError);
    expect(() => planSplit(meta(10), { ...OPTS, maxPages: 0 })).toThrow(HappyworkError);
  });
});

describe("纯函数性", () => {
  test("同样输入得到同样输出", () => {
    const m = meta(266);
    const a = planSplit(m, { ...OPTS, chapters: [{ title: "x", srcStart: 142 }] });
    const b = planSplit(m, { ...OPTS, chapters: [{ title: "x", srcStart: 142 }] });
    expect(JSON.stringify(a.chunks)).toBe(JSON.stringify(b.chunks));
  });

  test("不改动传入的 meta", () => {
    const m = meta(266);
    const before = JSON.stringify(m);
    planSplit(m, OPTS);
    expect(JSON.stringify(m)).toBe(before);
  });
});
