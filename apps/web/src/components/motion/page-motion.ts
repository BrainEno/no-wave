import gsap from "gsap";
import { ScrollTrigger } from "gsap/ScrollTrigger";
import { motionState } from "@/lib/motion-state.ts";

/**
 * 页面级滚动动效：通过 data 属性声明，页面组件保持为服务端组件。
 *  [data-intro] i      首屏字标逐字落下（有载入页时等待 nw:loaded）
 *  [data-scatter] i    首屏字标随滚动散开
 *  [data-hero]         首屏滚动：品牌上移、精选条淡出
 *  [data-reveal]       进入视口：mask 遮罩展开 / row 左右撞入 / wipe 横扫 / 其余淡入上移
 *  [data-parallax]     内部图片视差
 *  [data-marquee]      跑马灯（随滚动速度加速、反向）
 *  [data-footer-letters] i  页脚字母崩落
 */
export function setupPageMotion(): { revert(): void } {
  const cleanups: Array<() => void> = [];
  const ctx = gsap.context(() => {});
  const all = <T extends HTMLElement>(selector: string) => gsap.utils.toArray<T>(selector);

  ctx.add(() => {
    const letters = all<HTMLElement>("[data-intro] i");
    const scatter = () => {
      ctx.add(() => {
        all<HTMLElement>("[data-scatter] i").forEach((letter) => {
          gsap.to(letter, {
            yPercent: gsap.utils.random(-50, 70), rotate: gsap.utils.random(-40, 40), ease: "none",
            scrollTrigger: { trigger: "[data-hero]", start: "top top", end: "bottom top", scrub: true },
          });
        });
      });
    };
    if (letters.length) {
      gsap.set(letters, { yPercent: -130, rotate: () => gsap.utils.random(-30, 30) });
      const run = () => ctx.add(() => {
        gsap.to(letters, { yPercent: 0, rotate: 0, duration: 1.1, ease: "power4.out", stagger: { each: 0.06, from: "random" }, onComplete: scatter });
      });
      // 载入页可能先于本函数完成（会话内二次进入）：用状态位兜底，避免字标卡在隐藏位。
      if (motionState.loaded) run();
      else {
        const onLoaded = () => run();
        window.addEventListener("nw:loaded", onLoaded, { once: true });
        cleanups.push(() => window.removeEventListener("nw:loaded", onLoaded));
      }
    }

    const hero = document.querySelector("[data-hero]");
    if (hero) {
      const scrub = { trigger: hero, start: "top top", end: "bottom top", scrub: true };
      gsap.to(".nw-brand", { yPercent: -12, ease: "none", scrollTrigger: scrub });
      gsap.to(".nw-feature", { yPercent: -120, opacity: 0, ease: "none", scrollTrigger: scrub });
    }

    all<HTMLElement>("[data-reveal]").forEach((element, index) => {
      const mode = element.dataset.reveal;
      if (mode === "mask") {
        gsap.from(element, { clipPath: "inset(100% 0 0 0)", duration: 1.2, ease: "power4.out", scrollTrigger: { trigger: element, start: "top 88%" } });
      } else if (mode === "row") {
        gsap.from(element, { xPercent: index % 2 ? 12 : -12, opacity: 0, duration: 0.9, ease: "power3.out", scrollTrigger: { trigger: element, start: "top 92%" } });
      } else if (mode === "wipe") {
        gsap.from(element, { clipPath: "inset(0 100% 0 0)", x: index % 2 ? 60 : -60, duration: 1, ease: "power3.out", scrollTrigger: { trigger: element, start: "top 94%" } });
      } else {
        gsap.from(element, { y: 40, opacity: 0, duration: 0.9, ease: "power3.out", scrollTrigger: { trigger: element, start: "top 90%" } });
      }
    });

    all<HTMLElement>("[data-parallax]").forEach((element) => {
      const image = element.querySelector("img");
      if (!image) return;
      gsap.fromTo(image, { yPercent: -6 }, { yPercent: 6, ease: "none", scrollTrigger: { trigger: element, start: "top bottom", end: "bottom top", scrub: true } });
    });

    const tweens: gsap.core.Tween[] = [];
    const speed = { v: 1 };
    all<HTMLElement>("[data-marquee]").forEach((track) => {
      const direction = Number(track.dataset.marquee) < 0 ? -1 : 1;
      const copies = Number(track.dataset.copies) || 6;
      tweens.push(gsap.fromTo(track, { xPercent: direction < 0 ? 0 : -100 / copies }, { xPercent: direction < 0 ? -100 / copies : 0, duration: 26, repeat: -1, ease: "none" }));
    });
    if (tweens.length) {
      const tick = () => tweens.forEach((tween) => tween.timeScale(speed.v));
      gsap.ticker.add(tick);
      const settle = () => { gsap.to(speed, { v: 1, duration: 1.2, overwrite: true }); };
      ScrollTrigger.addEventListener("scrollEnd", settle);
      cleanups.push(() => { gsap.ticker.remove(tick); ScrollTrigger.removeEventListener("scrollEnd", settle); });
      ScrollTrigger.create({
        onUpdate(self) { gsap.to(speed, { v: self.direction * (1 + Math.min(14, Math.abs(self.getVelocity()) / 110)), duration: 0.3, overwrite: true }); },
      });
    }

    all<HTMLElement>("[data-footer-letters] i").forEach((letter) => {
      gsap.from(letter, {
        yPercent: gsap.utils.random(60, 140), rotate: gsap.utils.random(-45, 45), ease: "none",
        scrollTrigger: { trigger: ".nw-footer", start: "top 95%", end: "top 30%", scrub: true },
      });
    });
  });

  return { revert() { cleanups.forEach((fn) => fn()); ctx.revert(); } };
}
