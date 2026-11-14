import { NotificationProvider, useNotifications } from "./notification-provider.tsx";
import { notificationEntries } from "@/lib/notification-controller.ts";
import { notificationProblemText, notificationSummary } from "@/lib/notification-feedback.ts";
import { Link } from "@/lib/framework/link.tsx";
import { usePathname } from "@/lib/framework/navigation.ts";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { dateLabel } from "@/lib/format.ts";
import {
  notificationPresentation,
  grainOffsets,
  grainTileData,
  shouldUseSmoothScroll,
  unreadBadge,
} from "@/lib/chrome.ts";
import gsap from "gsap";
import { ScrollTrigger } from "gsap/ScrollTrigger";
import { ScrollSmoother } from "gsap/ScrollSmoother";
import { archivePath, homePath, type Locale } from "@/lib/content.ts";
import { getUi } from "@/lib/ui-copy.ts";
import { tagIndexPath } from "@/lib/tag-discovery.ts";
import { motionState } from "@/lib/motion-state.ts";
import { setupPageMotion } from "@/components/motion/page-motion.ts";

function localeOf(pathname: string): Locale {
  return pathname === "/en" || pathname.startsWith("/en/") ? "en" : "zh-CN";
}

/** 语言切换：优先进入对应页面；作品详情的译文不一定存在，因此回到对应语言的作品列表。 */
function alternatePath(pathname: string, locale: Locale): string {
  const target: Locale = locale === "en" ? "zh-CN" : "en";
  const bare = locale === "en" ? (pathname.replace(/^\/en/, "") || "/") : pathname;
  if (/^\/articles\/[^/]+/.test(bare)) return archivePath(target);
  // As with an article, a tag's translated identity may not exist. The target
  // directory is reachable without claiming a translation that was never read.
  if (/^\/tags\/[^/]+/.test(bare)) return tagIndexPath(target);
  if (/^\/(authors\/[^/]+|(?:categories|tags)(\/[^/]+)?|articles|search)?$/.test(bare) || bare === "/") {
    return target === "en" ? (bare === "/" ? "/en" : "/en" + bare) : bare;
  }
  return homePath(target);
}

const icon = {
  search: <svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="11" cy="11" r="7" /><path d="M20 20l-4-4" /></svg>,
  bell: <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 8a6 6 0 0112 0c0 7 3 8 3 8H3s3-1 3-8" /><path d="M10.3 20a2 2 0 003.4 0" /></svg>,
};

const GRAIN_TILE_SIZE = 256;

function GrainCanvas() {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const canvas = ref.current;
    const context = canvas?.getContext("2d");
    if (!canvas || !context || window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;

    // One 256×256 tile is generated once. Every frame afterwards is a single
    // pattern fill shifted by a precomputed offset, not a full-screen pixel loop.
    const tile = document.createElement("canvas");
    tile.width = GRAIN_TILE_SIZE;
    tile.height = GRAIN_TILE_SIZE;
    const tileContext = tile.getContext("2d");
    if (!tileContext) return;
    const image = tileContext.createImageData(GRAIN_TILE_SIZE, GRAIN_TILE_SIZE);
    image.data.set(grainTileData(GRAIN_TILE_SIZE));
    tileContext.putImageData(image, 0, 0);
    const pattern = context.createPattern(tile, "repeat");
    if (!pattern) return;
    const offsets = grainOffsets(GRAIN_TILE_SIZE);
    let offsetIndex = 0;
    const paint = () => {
      const [dx, dy] = offsets[offsetIndex++ % offsets.length];
      context.setTransform(1, 0, 0, 1, 0, 0);
      context.clearRect(0, 0, canvas.width, canvas.height);
      context.translate(-dx, -dy);
      context.fillStyle = pattern;
      context.fillRect(0, 0, canvas.width + GRAIN_TILE_SIZE, canvas.height + GRAIN_TILE_SIZE);
    };
    const resize = () => {
      canvas.width = Math.ceil(window.innerWidth / 2);
      canvas.height = Math.ceil(window.innerHeight / 2);
      paint();
    };
    resize();
    const timer = window.setInterval(() => { if (!document.hidden) paint(); }, 125);
    window.addEventListener("resize", resize);
    return () => { window.clearInterval(timer); window.removeEventListener("resize", resize); };
  }, []);
  return <canvas className="nw-grain" ref={ref} aria-hidden="true" />;
}

function SiteFooter({ locale }: { locale: Locale }) {
  const ui = getUi(locale);
  const pathname = usePathname() ?? "/";
  const onHome = pathname === "/" || pathname === "/en";
  const home = homePath(locale);
  const topicsHref = locale === "en" ? "/en/categories" : "/categories";
  const searchHref = locale === "en" ? "/en/search" : "/search";
  const authorsHref = locale === "en" ? "/en/authors" : "/authors";
  return (
    <footer className="nw-footer">
      <div className="nw-fim">
        <img src="/covers/cover-oxblood-4x5.jpg" alt="" loading="lazy" width={1200} height={1500} />
        <div className="nw-fwm" aria-hidden="true" data-footer-letters><span className="nw-ss"><i>N</i><i>o</i></span> <span className="nw-it"><i>W</i><i>a</i><i>v</i><i>e</i></span></div>
      </div>
      {/* 页尾条：demo 的四栏布置（首页 / Blog / 主题 / 搜索 → 首页 / 最新 / 分类 / 搜索）。 */}
      <div className="nw-fbar">
        <nav aria-label={ui.nav.footer}>
          <Link href={home}>{ui.nav.home}</Link>
          <Link href={onHome ? "#latest" : `${home}#latest`}>{ui.nav.latest}</Link>
          <Link href={onHome ? "#topics" : topicsHref}>{ui.nav.topics}</Link>
          {/* A directory with no way in is a page nobody visits: the footer is
              where the reading index lives, so this is where the authors go. */}
          <Link href={authorsHref}>{ui.nav.authors}</Link>
          <Link href={tagIndexPath(locale)}>{ui.nav.tags}</Link>
          <Link href={searchHref}>{ui.nav.search}</Link>
        </nav>
        <span>© {new Date().getFullYear()} {ui.footer.rights} · 简 / EN</span>
      </div>
    </footer>
  );
}

export function SiteChrome({ children }: { children: ReactNode }) {
  return <NotificationProvider><SiteChromeContent>{children}</SiteChromeContent></NotificationProvider>;
}

function SiteChromeContent({ children }: { children: ReactNode }) {
  const pathname = usePathname() ?? "/";
  const locale = localeOf(pathname);
  const ui = getUi(locale);
  const smoothEnabled = shouldUseSmoothScroll(pathname);
  const [bellOpen, setBellOpen] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const { controller, snapshot } = useNotifications(bellOpen);
  const sessionUsable = snapshot.session === "unknown" ? null : snapshot.session === "active";
  const unread = snapshot.unread ?? 0;
  const bellState = snapshot.loaded ? "ready" : snapshot.status;
  const bellError = snapshot.error ? notificationProblemText(snapshot.error, locale) : "";
  const bellRows = notificationEntries(snapshot);
  const bellPending = snapshot.pending !== null;
  const bellCursor = snapshot.nextCursor;
  const summary = notificationSummary(snapshot, locale);
  const loadMoreBell = () => controller.loadMore();
  const markBellRead = (id?: string) => controller.markRead(id);
  const smoother = useRef<ScrollSmoother | null>(null);
  const pageMotion = useRef<{ revert(): void } | null>(null);
  const lastKey = useRef("");

  // 平滑滚动：阅读页共用一次实例；写作/账户/管理/登录等表单页恢复原生滚动。
  useEffect(() => {
    if (!smoothEnabled || window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    gsap.registerPlugin(ScrollTrigger, ScrollSmoother);
    const instance = ScrollSmoother.create({ wrapper: "#smooth-wrapper", content: "#smooth-content", smooth: 1.2, effects: true });
    smoother.current = instance;
    document.documentElement.classList.add("nw-smooth");
    const velocity = ScrollTrigger.create({
      onUpdate(self) { motionState.scrollVelocity = gsap.utils.clamp(-1, 1, self.getVelocity() / 3000); },
    });
    const decay = () => { motionState.scrollVelocity *= 0.92; };
    gsap.ticker.add(decay);
    return () => {
      gsap.ticker.remove(decay);
      velocity.kill();
      instance.kill();
      smoother.current = null;
      document.documentElement.classList.remove("nw-smooth");
    };
  }, [smoothEnabled]);

  // 页面级动效：路径或查询串变化后重新绑定
  useEffect(() => {
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    const key = window.location.pathname + window.location.search;
    if (key === lastKey.current) return;
    const first = lastKey.current === "";
    lastKey.current = key;
    pageMotion.current?.revert();
    if (!first) smoother.current?.scrollTop(0);
    pageMotion.current = setupPageMotion();
    const frame = window.requestAnimationFrame(() => ScrollTrigger.refresh());
    // 跨页 #hash 落点（如从文章页回到 /#selected）：挂载后滚到对应区块。
    let hashTimer = 0;
    const hash = window.location.hash.slice(1);
    if (hash) {
      const target = document.getElementById(hash);
      if (target) {
        hashTimer = window.setTimeout(() => {
          if (smoother.current) smoother.current.scrollTo(target, true, "top 24px");
          else target.scrollIntoView({ behavior: "smooth" });
        }, 80);
      }
    }
    return () => {
      window.cancelAnimationFrame(frame);
      window.clearTimeout(hashTimer);
    };
  });
  useEffect(() => () => { pageMotion.current?.revert(); pageMotion.current = null; lastKey.current = ""; }, []);

  // 页内锚点（目录等）使用平滑滚动。
  // 捕获阶段拦截 + stopPropagation：Next <Link> 对 #hash 的默认处理会在冒泡阶段
  // 调用 target.scrollIntoView()，把 overflow:hidden 的 #smooth-wrapper 也原生滚动，
  // 导致整页内容被钳位上移（首屏缺一截、落点偏到按钮、页脚下方露黑底）。
  useEffect(() => {
    const onClick = (event: MouseEvent) => {
      const anchor = (event.target as Element | null)?.closest?.('a[href^="#"]');
      const hash = anchor?.getAttribute("href");
      if (!hash || hash.length < 2) return;
      const target = document.querySelector(hash);
      if (!target) return;
      event.preventDefault();
      event.stopPropagation();
      // This capture listener owns hash navigation, so a React onClick would
      // never run. Move keyboard focus before scrolling for the skip link.
      if (anchor?.classList.contains("nw-skip") && target instanceof HTMLElement) {
        target.focus({ preventScroll: true });
      }
      if (smoother.current) smoother.current.scrollTo(target, true, "top 24px");
      else target.scrollIntoView({ behavior: "smooth" });
    };
    document.addEventListener("click", onClick, true);
    return () => document.removeEventListener("click", onClick, true);
  }, []);

  // 平滑容器只允许 transform 位移：任何原生滚动（scrollIntoView、焦点找回、
  // 浏览器锚点跳转）都会钳位内容，立刻归零。
  useEffect(() => {
    if (!smoothEnabled) return;
    const wrapper = document.getElementById("smooth-wrapper");
    if (!wrapper) return;
    const keepAtZero = () => {
      if (wrapper.scrollTop !== 0) wrapper.scrollTop = 0;
      if (wrapper.scrollLeft !== 0) wrapper.scrollLeft = 0;
    };
    wrapper.addEventListener("scroll", keepAtZero, { passive: true });
    return () => wrapper.removeEventListener("scroll", keepAtZero);
  }, [smoothEnabled]);

  useEffect(() => {
    setBellOpen(false); setMenuOpen(false);
  }, [pathname]);
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => { if (event.key === "Escape") { setBellOpen(false); setMenuOpen(false); } };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const other: Locale = locale === "en" ? "zh-CN" : "en";
  const current = (prefix: string) => (pathname === prefix || pathname.startsWith(prefix + "/") ? "page" : undefined);
  // 主导航：精选 / 最新 / 分类（按需求固定这三个入口）。
  // 首页内点击平滑滚动到对应区块；其他页面回到首页区块，分类保留项目实际的分类页入口。
  const onHome = pathname === "/" || pathname === "/en";
  const home = homePath(locale);
  const navSelected = onHome ? "#selected" : `${home}#selected`;
  const navLatest = onHome ? "#latest" : `${home}#latest`;
  const topicsHref = locale === "en" ? "/en/categories" : "/categories";
  const navTopics = onHome ? "#topics" : topicsHref;
  const searchHref = locale === "en" ? "/en/search" : "/search";
  const badge = unreadBadge(unread);


  return (
    <>
      <a className="nw-skip" href="#top">{locale === "en" ? "Skip to main content" : "跳到正文"}</a>
      <GrainCanvas />
      <Link className="nw-rail" href={homePath(locale)} aria-label={`${ui.rail} — ${ui.homeAria}`}>{ui.rail}</Link>
      <nav className="nw-pill" aria-label={ui.nav.primary} lang={locale}>
        <Link className="nw-nv" href={navSelected}>{ui.nav.selected}</Link>
        <Link className="nw-nv" href={navLatest}>{ui.nav.latest}</Link>
        <Link className="nw-nv" href="/write">{ui.nav.write}</Link>
        {/*
          The account entry is a plain link, not a session-aware one: the chrome
          is shared by every page, and reading a cookie in the layout would make
          every public page uncacheable. `/account` already answers both states
          — it redirects to sign-in with `next=/account` when there is no
          session, so a signed-out visitor who clicks it is sent to log in and
          comes straight back.
        */}
        <Link className="nw-nv" href="/account" aria-current={current("/account")}>{ui.nav.account}</Link>
        <Link className="nw-nv" href={navTopics} aria-current={onHome ? undefined : current(topicsHref)}>{ui.nav.topics}</Link>
        <span className="nw-sep nw-nv" aria-hidden="true" />
        <Link className="nw-nv nw-lang" href={locale === "en" ? alternatePath(pathname, locale) : pathname} lang="zh-CN" aria-current={locale === "zh-CN" ? "true" : undefined}>简</Link>
        <span className="nw-nv" aria-hidden="true">/</span>
        <Link className="nw-nv nw-lang" href={locale === "en" ? pathname : alternatePath(pathname, locale)} lang="en" aria-current={locale === "en" ? "true" : undefined}>EN</Link>
        <Link className="nw-ic" href={searchHref} aria-label={ui.nav.search}>{icon.search}</Link>
        <button className="nw-ic" type="button" aria-label={badge ? `${ui.bell.label}，${badge} ${ui.bell.unread}` : ui.bell.label} aria-expanded={bellOpen} aria-controls="nw-np" onClick={() => { setBellOpen((value) => !value); setMenuOpen(false); }}>
          {icon.bell}{badge ? <span className="nw-bdg" aria-live="polite">{badge}</span> : null}
        </button>
        <button className="nw-mnb" type="button" style={{ fontWeight: 700 }} aria-expanded={menuOpen} aria-controls="nw-menu" onClick={() => { setMenuOpen(true); setBellOpen(false); }}>{ui.nav.menu}</button>
      </nav>
      <div className="nw-np" id="nw-np" hidden={!bellOpen} role="dialog" aria-label={ui.bell.label} lang={locale} aria-busy={bellPending}>
        <header>
          <span>{ui.bell.label}</span>
          {sessionUsable === true ? <button type="button" disabled={bellPending} onClick={() => void controller.refresh()}>{locale === "en" ? "Refresh notifications" : "刷新通知"}</button> : null}
          {sessionUsable === true && bellState === "ready" && unread > 0 ? (
            <button className="nw-np-mark-all" type="button" disabled={bellPending} onClick={() => void markBellRead()}>{ui.bell.markAllRead}</button>
          ) : null}
          <button type="button" onClick={() => setBellOpen(false)}>{ui.nav.close}</button>
        </header>
        <div className="nw-np-body">
          {sessionUsable === null ? <p>{ui.bell.loading}</p> : null}
          {sessionUsable === false ? (
            <>
              <p>{ui.bell.empty}。{ui.bell.hint}</p>
              <Link className="nw-btn nw-sec" href="/sign-in">{ui.bell.signIn} →</Link>
            </>
          ) : null}
          {sessionUsable === true && bellState === "loading" ? <p>{ui.bell.loading}</p> : null}
          {sessionUsable === true && bellState === "error" ? <p role="alert">{bellError}</p> : null}
          {sessionUsable === true && bellState === "ready" && bellRows.length === 0 ? <p>{unread > 0 ? (locale === "en" ? "Unread notifications remain. Refresh to retrieve the latest list." : "尚有未读通知，请刷新以取得最新列表。") : `${ui.bell.empty}。`}</p> : null}
          {sessionUsable === true && summary ? <p>{summary}</p> : null}
          {sessionUsable === true && bellState === "ready" && bellError ? <p role="alert">{bellError}</p> : null}
          {sessionUsable === true && bellState === "ready" && bellRows.length > 0 ? (
            <ul className="nw-np-list">
              {bellRows.map(({ item, notice, read }) => (
                <li className="nw-np-row" key={item.id}>
                  <p className={!read ? "nw-np-text nw-np-unread" : "nw-np-text"}>{notificationPresentation(notice, locale).text}{notificationPresentation(notice, locale).href ? <> <Link href={notificationPresentation(notice, locale).href!} onClick={() => setBellOpen(false)}>{locale === "en" ? "View" : "查看"}</Link></> : null}</p>
                  <time className="nw-np-time" dateTime={item.createdAt}>{dateLabel(item.createdAt, locale)}</time>
                  {!read ? (
                    <button type="button" disabled={bellPending} onClick={() => void markBellRead(item.id)}>{ui.bell.markRead}</button>
                  ) : null}
                </li>
              ))}
            </ul>
          ) : null}
          {sessionUsable === true && bellState === "ready" && bellCursor ? <button className="nw-btn" type="button" disabled={bellPending} onClick={() => void loadMoreBell()}>{locale === "en" ? "Load more notifications" : "加载更多通知"}</button> : null}
        </div>
      </div>
      <div className="nw-menu" id="nw-menu" hidden={!menuOpen} role="dialog" aria-label={ui.nav.menu} lang={locale}>
        <button type="button" onClick={() => setMenuOpen(false)}>{ui.nav.close}</button>
        <Link href={homePath(locale)}>{ui.nav.home}</Link>
        <Link href={navSelected}>{ui.nav.selected}</Link>
        <Link href={navLatest}>{ui.nav.latest}</Link>
        <Link href="/write">{ui.nav.write}</Link>
        <Link href="/account">{ui.nav.account}</Link>
        <Link href={navTopics}>{ui.nav.topics}</Link>
        <Link href={searchHref}>{ui.nav.search}</Link>
        <Link href={alternatePath(pathname, locale)} lang={other} aria-label={ui.nav.language}>{other === "en" ? "English" : "简体中文"}</Link>
      </div>
      <div id="smooth-wrapper">
        <div id="smooth-content">
          {children}
          <SiteFooter locale={locale} />
        </div>
      </div>
    </>
  );
}
