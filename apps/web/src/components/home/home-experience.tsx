"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import gsap from "gsap";
import { ScrollTrigger } from "gsap/ScrollTrigger";
import { ScrollSmoother } from "gsap/ScrollSmoother";
import type { ArticleView, Locale } from "@/lib/content.ts";
import type { CategoryView } from "@/lib/api-content.ts";
import { archivePath, articlePath, getMessages } from "@/lib/content.ts";
import styles from "../home-page.module.css";
import {
  HOME_IMAGES,
  PANEL_IMAGE_SEQUENCE,
  getHomeCopy,
  homeDateLabel,
} from "./home-copy.ts";
import { GrainCanvas } from "./grain-canvas.tsx";
import { HeroGlCanvas, type HeroMotionState } from "./hero-gl-canvas.tsx";
import { LoadingScreen } from "./loading-screen.tsx";
import { HomeNav } from "./home-nav.tsx";

gsap.registerPlugin(ScrollTrigger, ScrollSmoother);

const CARD_IMAGES = [HOME_IMAGES.c1, HOME_IMAGES.c2, HOME_IMAGES.c3] as const;
const MARQUEE_UNITS = 6;

function usePrefersReducedMotion(): boolean {
  const [reduced, setReduced] = useState(false);
  useEffect(() => {
    const query = window.matchMedia("(prefers-reduced-motion: reduce)");
    const update = () => setReduced(query.matches);
    update();
    query.addEventListener("change", update);
    return () => query.removeEventListener("change", update);
  }, []);
  return reduced;
}

function SplitLetters({ text }: { text: string }) {
  return (
    <>
      {Array.from(text).map((character, index) => (
        <i key={index}>{character}</i>
      ))}
    </>
  );
}

export function HomeExperience({
  locale,
  articles,
  categories,
}: {
  locale: Locale;
  articles: ArticleView[];
  categories: CategoryView[];
}) {
  const english = locale === "en";
  const copy = getHomeCopy(locale);
  const messages = getMessages(locale);
  const reduced = usePrefersReducedMotion();
  const [opened, setOpened] = useState(false);
  const [panelActive, setPanelActive] = useState(0);

  const rootRef = useRef<HTMLElement>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const motionRef = useRef<HeroMotionState>({ rev: 0, sv: 0 });

  const handleOpened = useCallback(() => setOpened(true), []);

  const featured = articles.slice(0, 3);
  const latest = articles.length > 1 ? articles.slice(1, 6) : articles.slice(0, 5);
  const archiveHref = archivePath(locale);
  const categoriesHref = english ? "/en/categories" : "/categories";
  const rowStartNumber = featured.length > 0 ? 2 : 1;
  const year = new Date().getFullYear();

  useEffect(() => {
    if (reduced) motionRef.current.rev = 1;
  }, [reduced]);

  useEffect(() => {
    if (reduced || !opened) return;
    const root = rootRef.current;
    const wrapper = wrapRef.current;
    const content = contentRef.current;
    if (!root || !wrapper || !content) return;

    let smoother: ScrollSmoother | null = null;
    let velocityTrigger: ScrollTrigger | null = null;
    let anchorController: AbortController | null = null;
    const marqueeTweens: gsap.core.Tween[] = [];
    const marqueeState = { v: 1 };
    const applyMarqueeSpeed = () => {
      marqueeTweens.forEach((tween) => tween.timeScale(marqueeState.v));
    };
    const onScrollEnd = () => {
      gsap.to(marqueeState, { v: 1, duration: 1.2, overwrite: true });
    };

    const ctx = gsap.context(() => {
      try {
        smoother = ScrollSmoother.create({ wrapper, content, smooth: 1.2, effects: true });
      } catch {
        wrapper.style.position = "static";
        wrapper.style.overflow = "visible";
      }

      const cnLetters = gsap.utils.toArray<HTMLElement>(`.${styles.cn} i`, root);
      const wordmarkLetters = gsap.utils.toArray<HTMLElement>(`.${styles.hero} .${styles.wm} i`, root);
      gsap.set(wordmarkLetters.concat(cnLetters), {
        yPercent: -130,
        rotate: () => gsap.utils.random(-30, 30),
      });

      const entrance = gsap.timeline();
      entrance
        .to(motionRef.current, { rev: 1, duration: 2.8, ease: "power2.out" })
        .to(
          cnLetters.concat(wordmarkLetters),
          { yPercent: 0, rotate: 0, duration: 1.1, ease: "power4.out", stagger: { each: 0.06, from: "random" } },
          "-=2.4",
        );

      const hero = root.querySelector<HTMLElement>(`.${styles.hero}`);
      if (hero) {
        const heroScrub = { trigger: hero, start: "top top", end: "bottom top", scrub: true };
        gsap.to(`.${styles.brand}`, { yPercent: -12, ease: "none", scrollTrigger: heroScrub });
        gsap.to(`.${styles.chip}`, { yPercent: -120, opacity: 0, ease: "none", scrollTrigger: heroScrub });
      }

      root.querySelectorAll<HTMLElement>(`.${styles.ph}`).forEach((photo) => {
        const image = photo.querySelector("img");
        gsap.from(photo, {
          clipPath: "inset(100% 0 0 0)",
          duration: 1.2,
          ease: "power4.out",
          scrollTrigger: { trigger: photo, start: "top 88%" },
        });
        if (image) {
          gsap.fromTo(
            image,
            { yPercent: -6 },
            {
              yPercent: 6,
              ease: "none",
              scrollTrigger: { trigger: photo, start: "top bottom", end: "bottom top", scrub: true },
            },
          );
        }
      });

      root.querySelectorAll<HTMLElement>(`.${styles.tk}`).forEach((track) => {
        marqueeTweens.push(
          gsap.fromTo(track, { xPercent: 0 }, { xPercent: -100 / MARQUEE_UNITS, duration: 26, repeat: -1, ease: "none" }),
        );
      });
      gsap.ticker.add(applyMarqueeSpeed);

      velocityTrigger = ScrollTrigger.create({
        onUpdate: (self) => {
          const velocity = self.getVelocity();
          motionRef.current.sv = gsap.utils.clamp(-1, 1, velocity / 3000);
          gsap.to(marqueeState, {
            v: self.direction * (1 + Math.min(14, Math.abs(velocity) / 110)),
            duration: 0.3,
            overwrite: true,
          });
        },
      });
      ScrollTrigger.addEventListener("scrollEnd", onScrollEnd);

      root.querySelectorAll<HTMLElement>(`.${styles.row}`).forEach((row, index) => {
        gsap.from(row, {
          xPercent: index % 2 ? 12 : -12,
          opacity: 0,
          duration: 0.9,
          ease: "power3.out",
          scrollTrigger: { trigger: row, start: "top 92%" },
        });
      });

      gsap.utils.toArray<HTMLElement>(`.${styles.topic}`, root).forEach((topic, index) => {
        gsap.from(topic, {
          clipPath: "inset(0 100% 0 0)",
          x: index % 2 ? 60 : -60,
          duration: 1,
          ease: "power3.out",
          scrollTrigger: { trigger: topic, start: "top 94%" },
        });
      });

      const footer = root.querySelector("footer");
      if (footer) {
        gsap.from(footer.querySelectorAll(`.${styles.wm} i`), {
          yPercent: 110,
          rotate: () => gsap.utils.random(-35, 35),
          duration: 1,
          ease: "power4.out",
          stagger: 0.07,
          scrollTrigger: { trigger: footer, start: "top 80%" },
        });
      }

      const controller = new AbortController();
      anchorController = controller;
      root.querySelectorAll<HTMLAnchorElement>('a[href^="#"]').forEach((anchor) => {
        anchor.addEventListener(
          "click",
          (event) => {
            const hash = anchor.getAttribute("href");
            if (!hash || hash.length < 2 || !smoother) return;
            const target = root.querySelector(hash);
            if (target) {
              event.preventDefault();
              smoother.scrollTo(target, true, "top 0px");
            }
          },
          { signal: controller.signal },
        );
      });
    }, root);

    return () => {
      anchorController?.abort();
      ScrollTrigger.removeEventListener("scrollEnd", onScrollEnd);
      velocityTrigger?.kill();
      gsap.ticker.remove(applyMarqueeSpeed);
      ctx.revert();
      smoother?.kill();
      wrapper.style.position = "";
      wrapper.style.overflow = "";
    };
  }, [opened, reduced, motionRef]);

  return (
    <main ref={rootRef} className={`${styles.site} ${reduced ? styles.reduced : ""}`} lang={locale}>
      <GrainCanvas reduced={reduced} />
      <LoadingScreen label={copy.loadingLabel} staticMode={reduced} onOpened={handleOpened} />
      <HomeNav locale={locale} copy={copy} />

      <div ref={wrapRef} className={`${styles.smootherWrap} ${reduced ? styles.staticWrap : ""}`}>
        <div ref={contentRef}>
          <header className={styles.hero} id="top" data-hero>
            {/* eslint-disable-next-line @next/next/no-img-element -- visual artwork driven by the WebGL layer */}
            <img className={styles.heroBg} src={HOME_IMAGES.hero} alt="" />
            <HeroGlCanvas src={HOME_IMAGES.hero} motionRef={motionRef} />
            {featured[0] ? (
              <Link className={styles.chip} href={articlePath(featured[0].slug, locale)}>
                <span className={styles.m}>01</span>
                <span className={styles.zh}>{featured[0].title}</span>
                <span aria-hidden="true">→</span>
              </Link>
            ) : null}
            <div className={styles.brand}>
              <p className={`${styles.cn} ${styles.zh}`} aria-hidden="true">
                <SplitLetters text="无浪潮" />
              </p>
              <h1 className={styles.wm} aria-label="No Wave">
                <span className={styles.ss} aria-hidden="true">
                  <SplitLetters text="No" />
                </span>{" "}
                <span className={`${styles.sf} ${styles.italic}`} aria-hidden="true">
                  <SplitLetters text="Wave" />
                </span>
              </h1>
            </div>
          </header>

          <section className={styles.selected} id="selected">
            <div className={styles.wrap}>
              <div className={styles.h2}>
                <h2>
                  <span className={styles.zh}>{copy.selectedPrimary}</span>{" "}
                  <span className={`${styles.sf} ${styles.italic}`}>{copy.selectedAccent}</span>
                </h2>
                {featured.length > 0 ? (
                  <span className={styles.m}>{`01 — ${String(featured.length).padStart(2, "0")}`}</span>
                ) : null}
              </div>
              {featured.length ? (
                <div className={styles.tri}>
                  {featured.map((article, index) => (
                    <Link
                      key={article.slug}
                      href={articlePath(article.slug, locale)}
                      className={`${styles.item} ${styles[`item${index + 1}`]}`}
                      data-speed={index === 1 ? 0.9 : index === 2 ? 1.1 : undefined}
                    >
                      <div className={styles.ph}>
                        {/* eslint-disable-next-line @next/next/no-img-element */}
                        <img src={CARD_IMAGES[index % CARD_IMAGES.length]} alt="" loading="lazy" />
                      </div>
                      <span className={styles.cap}>
                        <span className={styles.m}>
                          {String(index + 1).padStart(2, "0")} · {messages.workTypeLabels[article.workType]}
                        </span>
                        <span className={`${styles.t} ${styles.zh}`}>{article.title}</span>
                        <span className={styles.m}>{homeDateLabel(article.publishedAt, locale)}</span>
                      </span>
                    </Link>
                  ))}
                </div>
              ) : (
                <p className={styles.emptyState}>{copy.emptyResults}</p>
              )}
            </div>
          </section>

          <div className={styles.band} aria-hidden="true">
            <div className={styles.tk}>
              {Array.from({ length: MARQUEE_UNITS }, (_, index) => (
                <span className={styles.unit} key={index}>
                  <b>No Wave</b>
                  <i>/ 无浪潮 /</i>
                  <b>Archive</b>
                  <i>/ 档案 /</i>
                </span>
              ))}
            </div>
          </div>

          <section className={styles.latest} id="latest">
            <div className={styles.wrap}>
              <div className={`${styles.pic} ${panelActive >= 4 ? styles.picFallback : ""}`}>
                {latest.map((article, index) => (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img
                    key={article.slug}
                    src={PANEL_IMAGE_SEQUENCE[index % PANEL_IMAGE_SEQUENCE.length]}
                    alt=""
                    loading="lazy"
                    className={index === panelActive ? styles.on : undefined}
                    style={
                      index === 3
                        ? { objectPosition: "18% 60%" }
                        : index === 4
                          ? { objectPosition: "50% 20%" }
                          : undefined
                    }
                  />
                ))}
                <span className={`${styles.tag} ${styles.m}`}>{copy.fallbackCover}</span>
              </div>
              <div className={styles.list}>
                <div className={styles.h2} style={{ marginBottom: 48 }}>
                  <h2>
                    <span className={styles.zh}>{copy.latestPrimary}</span>{" "}
                    <span className={`${styles.sf} ${styles.italic}`}>{copy.latestAccent}</span>
                  </h2>
                </div>
                {latest.length ? (
                  latest.map((article, index) => (
                    <Link
                      key={article.slug}
                      href={articlePath(article.slug, locale)}
                      className={styles.row}
                      onMouseEnter={() => setPanelActive(Math.min(index, latest.length - 1))}
                      onFocus={() => setPanelActive(Math.min(index, latest.length - 1))}
                    >
                      <span className={styles.m}>{String(rowStartNumber + index).padStart(2, "0")}</span>
                      <span>
                        <span className={`${styles.t} ${styles.zh}`}>{article.title}</span>
                        <span className={styles.m}>
                          {messages.workTypeLabels[article.workType]} · {homeDateLabel(article.publishedAt, locale)}
                        </span>
                      </span>
                    </Link>
                  ))
                ) : (
                  <p className={styles.emptyState}>{copy.emptyResults}</p>
                )}
                <Link className={styles.more} href={archiveHref}>
                  {copy.browseAll} <span aria-hidden="true">→</span>
                </Link>
              </div>
            </div>
          </section>

          <section className={styles.topics} id="topics" aria-label={copy.navTopics}>
            <div className={styles.wrap}>
              <div className={styles.m} style={{ marginBottom: 40 }}>
                {copy.topicsEyebrow}
              </div>
              {categories.length ? (
                <div>
                  {categories.slice(0, 8).map((category, index) => (
                    <Link
                      key={category.slug}
                      className={styles.topic}
                      href={`${english ? "/en" : ""}/categories/${encodeURIComponent(category.slug)}`}
                    >
                      {category.name}
                      <sup>{String(index + 1).padStart(2, "0")}</sup>
                    </Link>
                  ))}
                </div>
              ) : (
                <div className={styles.topicFallback}>
                  <p>
                    {english
                      ? "Fiction, poetry, essays, criticism — each work deserves its own space."
                      : "小说、诗歌、散文与文学批评，各有自己的节奏与位置。"}
                  </p>
                </div>
              )}
              <Link className={styles.go} href={categoriesHref}>
                {copy.exploreTopics} <span aria-hidden="true">→</span>
              </Link>
            </div>
          </section>

          <footer>
            <div className={styles.footerImage}>
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={HOME_IMAGES.c1} alt="" loading="lazy" />
              <div className={`${styles.wm} ${styles.footerWm}`} aria-hidden="true">
                <span className={styles.ss}>
                  <SplitLetters text="No" />
                </span>{" "}
                <span className={`${styles.sf} ${styles.italic}`}>
                  <SplitLetters text="Wave" />
                </span>
              </div>
            </div>
            <div className={styles.footerBar}>
              <nav aria-label={english ? "Footer navigation" : "页尾导航"}>
                <a href="#top">{copy.footerHome}</a>
                <Link href={archiveHref}>{copy.footerBlog}</Link>
                <Link href={categoriesHref}>{copy.footerTopics}</Link>
                <Link href={archiveHref}>{copy.footerSearch}</Link>
              </nav>
              <span>{copy.rights(year)}</span>
            </div>
          </footer>
        </div>
      </div>
    </main>
  );
}
