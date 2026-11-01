"use client";

import { useEffect, useRef, useState } from "react";
import gsap from "gsap";
import { motionState } from "@/lib/motion-state.ts";

/** 首页载入页：计数 000→100，条状幕布撕开，随后首屏涂抹浮现。每个会话只播放一次。 */
export function PageLoader({ label }: { label: string }) {
  const [done, setDone] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const counter = useRef<HTMLSpanElement>(null);

  useEffect(() => {
    let finished = false;
    let started = false;
    let announced = false;
    // 字标入场事件：demo 在幕布撕完前 0.4s 让字标开始落下（与 .col 撕开重叠）。
    const announce = () => {
      if (announced) return;
      announced = true;
      motionState.loaded = true;
      window.dispatchEvent(new Event("nw:loaded"));
    };
    const finish = () => {
      if (finished) return;
      finished = true;
      announce();
      setDone(true);
    };
    const revealNow = () => {
      if (motionState.reveal < 1) gsap.to(motionState, { reveal: 1, duration: 2.8, ease: "power2.out" });
    };
    const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    let seen = false;
    try { seen = window.sessionStorage.getItem("nw-loaded") === "1"; } catch { /* 隐私模式 */ }
    if (reduce || seen) {
      motionState.reveal = 1;
      finish();
      return;
    }
    const state = { n: 0 };
    const paint = () => { if (counter.current) counter.current.textContent = String(Math.round(state.n)).padStart(3, "0"); };
    const curtain = () => {
      if (started) return;
      started = true;
      gsap.timeline()
        .to(".nw-ct", { opacity: 0, scale: 1.12, duration: 0.35 })
        .to(".nw-col", { yPercent: -101, duration: 0.9, ease: "power4.inOut", stagger: { each: 0.08, from: "random" } }, "-=0.1")
        // 与 demo 的 open() 逐拍对齐：浮现 .to(S,{rev:1},'-=.8')、字标 '-=2.4'（=幕布结束前 0.4s）。
        .add(revealNow, "-=0.8")
        .add(announce, "-=0.4")
        .add(() => {
          try { window.sessionStorage.setItem("nw-loaded", "1"); } catch { /* ignore */ }
          finish();
        });
    };
    const ctx = gsap.context(() => {
      gsap.to(state, { n: 88, duration: 1.8, ease: "power2.out", onUpdate: paint });
      const fonts = document.fonts ? document.fonts.ready : Promise.resolve();
      const loaded = document.readyState === "complete" ? Promise.resolve() : new Promise<void>((resolve) => window.addEventListener("load", () => resolve(), { once: true }));
      const minimum = new Promise<void>((resolve) => window.setTimeout(resolve, 1400));
      void Promise.all([fonts, loaded, minimum]).then(() => {
        gsap.to(state, {
          n: 100, duration: 0.35, onUpdate: paint,
          onComplete: curtain,
        });
      });
    }, root);
    // 兜底：字体/加载事件悬挂时也必须掀开幕布，保证字标与首屏动画按时播放。
    const bail = window.setTimeout(() => {
      gsap.to(state, { n: 100, duration: 0.2, onUpdate: paint, onComplete: curtain });
    }, 4500);
    return () => {
      window.clearTimeout(bail);
      ctx.revert();
    };
  }, []);

  if (done) return null;
  return (
    <div className="nw-load" data-loader ref={root} aria-hidden="true">
      <div className="nw-cols"><i className="nw-col" /><i className="nw-col" /><i className="nw-col" /><i className="nw-col" /><i className="nw-col" /><i className="nw-col" /></div>
      <div className="nw-ct"><span className="nw-cnt" ref={counter}>000</span><span className="nw-m" style={{ color: "#f2eee6" }}>{label}</span></div>
    </div>
  );
}
