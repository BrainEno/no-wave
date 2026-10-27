"use client";

import { useEffect, useRef, useState } from "react";

type BarLabels = { smaller: string; larger: string; theme: string; dark: string; light: string; copy: string; copied: string; sizeLabel: string };

const MIN = 16;
const MAX = 24;

/** 阅读设置：字号、纸/墨背景、复制链接。仅保存在本机（localStorage），不依赖后端。 */
export function ReaderBar({ labels }: { labels: BarLabels }) {
  const [size, setSize] = useState(19);
  const [choice, setChoice] = useState<"dark" | "light" | null>(null);
  const [systemDark, setSystemDark] = useState(false);
  const [status, setStatus] = useState("");

  useEffect(() => {
    setSystemDark(window.matchMedia("(prefers-color-scheme: dark)").matches);
    try {
      const saved = Number(window.localStorage.getItem("nw-fs"));
      if (saved >= MIN && saved <= MAX) setSize(saved);
      const theme = window.localStorage.getItem("nw-theme");
      if (theme === "dark" || theme === "light") setChoice(theme);
    } catch { /* 隐私模式下忽略 */ }
  }, []);
  useEffect(() => {
    document.documentElement.style.setProperty("--fs", `${size}px`);
    return () => { document.documentElement.style.removeProperty("--fs"); };
  }, [size]);
  useEffect(() => {
    if (!choice) return;
    const root = document.documentElement;
    root.dataset.theme = choice;
    return () => { delete root.dataset.theme; };
  }, [choice]);

  const dark = choice ? choice === "dark" : systemDark;
  const change = (delta: number) => {
    const next = Math.max(MIN, Math.min(MAX, size + delta));
    setSize(next);
    setStatus(labels.sizeLabel.replace("{n}", String(next)));
    try { window.localStorage.setItem("nw-fs", String(next)); } catch { /* ignore */ }
  };
  const toggleTheme = () => {
    const next = dark ? "light" : "dark";
    setChoice(next);
    try { window.localStorage.setItem("nw-theme", next); } catch { /* ignore */ }
  };
  const copy = async () => {
    try { await navigator.clipboard.writeText(window.location.href); setStatus(labels.copied); } catch { setStatus(window.location.href); }
  };

  return (
    <div className="nw-rs" role="group">
      <button type="button" aria-label={labels.smaller} onClick={() => change(-2)} disabled={size <= MIN}>A−</button>
      <button type="button" aria-label={labels.larger} onClick={() => change(2)} disabled={size >= MAX}>A+</button>
      <button type="button" aria-label={labels.theme} aria-pressed={dark} onClick={toggleTheme}>{dark ? labels.light : labels.dark}</button>
      <button type="button" onClick={copy}>{labels.copy}</button>
      <span className="nw-sr" role="status" aria-live="polite">{status}</span>
    </div>
  );
}

export function ReadingProgress({ label }: { label: string }) {
  const bar = useRef<HTMLElement>(null);
  useEffect(() => {
    const update = () => {
      const article = document.getElementById("nw-article");
      if (!article || !bar.current) return;
      const rect = article.getBoundingClientRect();
      const total = rect.height - window.innerHeight * 0.6;
      const done = Math.min(1, Math.max(0, (window.innerHeight * 0.4 - rect.top) / Math.max(total, 1)));
      bar.current.style.width = `${(done * 100).toFixed(1)}%`;
    };
    update();
    window.addEventListener("scroll", update, { passive: true });
    window.addEventListener("resize", update);
    return () => { window.removeEventListener("scroll", update); window.removeEventListener("resize", update); };
  }, []);
  return <div className="nw-progress" role="progressbar" aria-label={label} aria-valuemin={0} aria-valuemax={100}><i ref={bar} /></div>;
}

export function ReaderToc({ items, title }: { items: { id: string; text: string }[]; title: string }) {
  const [active, setActive] = useState(items[0]?.id ?? "");
  useEffect(() => {
    const targets = items.map((item) => document.getElementById(item.id)).filter((node): node is HTMLElement => node !== null);
    if (!targets.length) return;
    const observer = new IntersectionObserver((entries) => {
      const visible = entries.filter((entry) => entry.isIntersecting).sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top)[0];
      if (visible) setActive(visible.target.id);
    }, { rootMargin: "-20% 0px -65% 0px" });
    targets.forEach((target) => observer.observe(target));
    return () => observer.disconnect();
  }, [items]);
  return (
    <nav className="nw-toc" aria-label={title}>
      <div className="nw-m" style={{ marginBottom: 12 }}>{title}</div>
      {items.map((item) => <a key={item.id} href={`#${item.id}`} aria-current={active === item.id ? "true" : undefined}>{item.text}</a>)}
    </nav>
  );
}
