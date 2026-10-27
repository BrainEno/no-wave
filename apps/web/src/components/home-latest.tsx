"use client";

import Link from "next/link";
import { useState } from "react";

export type LatestItem = { href: string; title: string; meta: string; number: string; coverSrc: string; coverWidth: number; coverHeight: number };

/** 最新发表：悬停（或键盘聚焦）某一行时，左侧大图随之切换。 */
export function HomeLatest({ items, heading, allLabel, allHref }: { items: LatestItem[]; heading: React.ReactNode; allLabel: string; allHref: string }) {
  const [active, setActive] = useState(0);
  return (
    <div className="nw-wrap">
      <div className="nw-pic" data-reveal="mask" aria-hidden="true">
        {items.map((item, index) => <img key={item.href} src={item.coverSrc} alt="" width={item.coverWidth} height={item.coverHeight} loading="lazy" data-on={index === active ? "" : undefined} />)}
      </div>
      <div className="nw-list">
        {heading}
        {items.map((item, index) => (
          <Link key={item.href} className="nw-row" href={item.href} data-reveal="row" onMouseEnter={() => setActive(index)} onFocus={() => setActive(index)} style={{ gridTemplateColumns: "56px 1fr" }}>
            <span className="nw-m nw-rn">{item.number}</span>
            <span className="nw-rb"><span className="nw-t">{item.title}</span><span className="nw-m">{item.meta}</span></span>
          </Link>
        ))}
        <Link className="nw-more" href={allHref}>{allLabel} <span aria-hidden="true">→</span></Link>
      </div>
    </div>
  );
}
