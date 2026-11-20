import { useState } from "react";
import type {
  OverlapWorkbenchState,
  WritingOverlapWorkbench,
} from "@/lib/writing-overlap-controller.ts";
import type { OverlapPolicy } from "@/lib/writing-overlap-model.ts";

export function WritingOverlapConditions({
  controller,
  state,
  changed,
}: {
  controller: WritingOverlapWorkbench;
  state: OverlapWorkbenchState;
  changed: () => void;
}) {
  const [minimum, setMinimum] = useState(String(state.policy.minimum));
  const [threshold, setThreshold] = useState(String(state.policy.threshold));
  function editNumber(field: "minimum" | "threshold", value: string) {
    changed();
    controller.cancel(); // Even an unfinished/invalid numeric draft revokes old outputs immediately.
    if (field === "minimum") setMinimum(value);
    else setThreshold(value);
  }
  function apply(patch: Partial<OverlapPolicy>) {
    changed();
    controller.setPolicy({ ...state.policy, ...patch });
  }
  function analyze() {
    changed();
    if (
      controller.setPolicy({
        ...state.policy,
        minimum: Number(minimum),
        threshold: Number(threshold),
      })
    )
      void controller.analyze();
  }
  return (
    <form
      aria-label="本机段落分析条件"
      onSubmit={(event) => {
        event.preventDefault();
        analyze();
      }}
    >
      <div className="nw-collection-filter-grid">
        <label>
          文字比较模式
          <select
            aria-label="文字比较模式"
            value={state.policy.mode}
            onChange={(event) =>
              apply({ mode: event.target.value as OverlapPolicy["mode"] })
            }
          >
            <option value="literal">原始字面（默认，不折叠）</option>
            <option value="folded">NFKC、小写与空白折叠</option>
          </select>
        </label>
        <label>
          文稿配对范围
          <select
            aria-label="文稿配对范围"
            value={state.policy.scope}
            onChange={(event) =>
              apply({ scope: event.target.value as OverlapPolicy["scope"] })
            }
          >
            <option value="cross-document">不同文稿之间（默认）</option>
            <option value="within-document">各篇文稿内部</option>
            <option value="all">同篇与跨篇全部</option>
          </select>
        </label>
        <label>
          最短段落字符数
          <input
            type="number"
            required
            min={8}
            max={500}
            step={1}
            value={minimum}
            onChange={(event) => editNumber("minimum", event.target.value)}
          />
        </label>
        <label>
          近似候选最低百分比
          <input
            type="number"
            required
            min={50}
            max={95}
            step={1}
            value={threshold}
            onChange={(event) => editNumber("threshold", event.target.value)}
          />
        </label>
      </div>
      <p>
        只比较段落、标题、引用和列表项中的完整文字；跳过代码、空单元及少于最短长度的文字。最短长度按
        Unicode 代码点计数，组合字形可能含多个代码点。
      </p>
      <p>
        折叠模式仅为
        NFKC、非语言特定的小写与连续空白折叠，不去标点、词干化或翻译；原始文字与富文本节点仍保留。只有单篇时，可选择“各篇文稿内部”。
      </p>
      <div className="nw-authoring-actions">
        <button
          className="nw-btn"
          type="submit"
          disabled={state.status === "running"}
        >
          分析本机段落重复
        </button>
        {state.status === "running" ? (
          <button
            className="nw-btn"
            type="button"
            onClick={() => {
              changed();
              controller.cancel();
            }}
          >
            停止段落分析
          </button>
        ) : null}
      </div>
    </form>
  );
}
