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
    const finish = () => {
      setDone(true);
      window.dispatchEvent(new Event("nw:loaded"));
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
    const ctx = gsap.context(() => {
      gsap.to(state, { n: 88, duration: 1.8, ease: "power2.out", onUpdate: paint });
      const fonts = document.fonts ? document.fonts.ready : Promise.resolve();
      const loaded = document.readyState === "complete" ? Promise.resolve() : new Promise<void>((resolve) => window.addEventListener("load", () => resolve(), { once: true }));
      const minimum = new Promise<void>((resolve) => window.setTimeout(resolve, 1400));
      void Promise.all([fonts, loaded, minimum]).then(() => {
        gsap.to(state, {
          n: 100, duration: 0.35, onUpdate: paint,
          onComplete: () => {
            gsap.timeline()
              .to(".nw-ct", { opacity: 0, scale: 1.12, duration: 0.35 })
              .to(".nw-col", { yPercent: -101, duration: 0.9, ease: "power4.inOut", stagger: { each: 0.08, from: "random" } }, "-=0.1")
              .add(() => {
                try { window.sessionStorage.setItem("nw-loaded", "1"); } catch { /* ignore */ }
                finish();
                gsap.to(motionState, { reveal: 1, duration: 2.8, ease: "power2.out" });
              });
          },
        });
      });
    }, root);
    return () => ctx.revert();
  }, []);

  if (done) return null;
  return (
    <div className="nw-load" data-loader ref={root} aria-hidden="true">
      <div className="nw-cols"><i className="nw-col" /><i className="nw-col" /><i className="nw-col" /><i className="nw-col" /><i className="nw-col" /><i className="nw-col" /></div>
      <div className="nw-ct"><span className="nw-cnt" ref={counter}>000</span><span className="nw-m" style={{ color: "#f2eee6" }}>{label}</span></div>
    </div>
  );
}
