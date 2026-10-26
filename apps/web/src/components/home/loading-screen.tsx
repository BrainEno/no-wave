"use client";

import { useEffect, useRef } from "react";
import gsap from "gsap";
import styles from "../home-page.module.css";

/**
 * Editorial loading curtain: animated counter, then six black columns lift
 * away in a random stagger. In static (reduced-motion) mode it disappears
 * immediately and reports completion synchronously.
 */
export function LoadingScreen({
  label,
  staticMode,
  onOpened,
}: {
  label: string;
  staticMode: boolean;
  onOpened: () => void;
}) {
  const rootRef = useRef<HTMLDivElement>(null);
  const counterRef = useRef<HTMLSpanElement>(null);
  const openedRef = useRef(false);

  useEffect(() => {
    const root = rootRef.current;
    if (!root) return;

    const finish = () => {
      if (!openedRef.current) {
        openedRef.current = true;
        onOpened();
      }
    };

    if (staticMode) {
      root.style.display = "none";
      finish();
      return;
    }

    const counter = counterRef.current;
    const state = { n: 0 };
    const renderCounter = () => {
      if (counter) counter.textContent = String(Math.round(state.n)).padStart(3, "0");
    };

    const introTween = gsap.to(state, { n: 88, duration: 1.8, ease: "power2.out", onUpdate: renderCounter });
    let cancelled = false;
    let timeline: gsap.core.Timeline | null = null;

    const fontsReady = document.fonts ? document.fonts.ready : Promise.resolve();
    const windowLoaded =
      document.readyState === "complete"
        ? Promise.resolve()
        : new Promise<void>((resolve) =>
            window.addEventListener("load", () => resolve(), { once: true }),
          );
    const minimumDelay = new Promise<void>((resolve) => {
      window.setTimeout(resolve, 1400);
    });

    Promise.all([fontsReady, windowLoaded, minimumDelay]).then(() => {
      if (cancelled) return;
      gsap.to(state, {
        n: 100,
        duration: 0.35,
        onUpdate: renderCounter,
        onComplete: openCurtain,
      });
    });

    function openCurtain() {
      if (cancelled || !rootRef.current) return;
      // The entrance choreography starts while the columns are still lifting.
      finish();
      const center = rootRef.current.querySelector(`.${styles.loadCenter}`);
      const columns = rootRef.current.querySelectorAll(`.${styles.loadCol}`);
      timeline = gsap
        .timeline()
        .to(center, { opacity: 0, scale: 1.12, duration: 0.35 })
        .to(columns, { yPercent: -101, duration: 0.9, ease: "power4.inOut", stagger: { each: 0.08, from: "random" } }, "-=0.1")
        .add(() => {
          if (rootRef.current) rootRef.current.style.display = "none";
        });
    }

    return () => {
      cancelled = true;
      introTween.kill();
      gsap.killTweensOf(state);
      if (timeline) timeline.kill();
    };
  }, [staticMode, onOpened]);

  return (
    <div ref={rootRef} className={styles.load} aria-hidden="true">
      <div className={styles.loadCols}>
        {Array.from({ length: 6 }, (_, index) => (
          <i className={styles.loadCol} key={index} />
        ))}
      </div>
      <div className={styles.loadCenter}>
        <span ref={counterRef} className={styles.counter}>
          000
        </span>
        <span className={styles.loadLabel}>{label}</span>
      </div>
    </div>
  );
}
