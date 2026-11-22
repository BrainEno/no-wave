import { useChromeOverlays } from "@/lib/use-chrome-overlays.ts";
import { alternatePath, localeDestination, localeOf, notificationInboxPath } from "@/lib/locale-navigation.ts";
import { NotificationProvider, useNotifications } from "./notification-provider.tsx";
import { notificationEntries } from "@/lib/notification-controller.ts";
import { notificationProblemText, notificationSummary } from "@/lib/notification-feedback.ts";
import { Link } from "@/lib/framework/link.tsx";
import { usePageLocation, usePathname } from "@/lib/framework/navigation.ts";
import { useEffect, useRef, type ReactNode } from "react";
import { dateLabel } from "@/lib/format.ts";
import {
  notificationPresentation,
  grainTileData,
  isReadingRoute,
  shouldPaintGrain,
  shouldUseSmoothScroll,
  isToolRoute,
  unreadBadge,
} from "@/lib/chrome.ts";
import gsap from "gsap";
import { ScrollTrigger } from "gsap/ScrollTrigger";
import { ScrollSmoother } from "gsap/ScrollSmoother";
import { homePath, type Locale } from "@/lib/content.ts";
import { getUi } from "@/lib/ui-copy.ts";
import { tagIndexPath } from "@/lib/tag-discovery.ts";
import { motionState } from "@/lib/motion-state.ts";
import { setupPageMotion } from "@/components/motion/page-motion.ts";
import { ReadingShelfProvider } from "@/components/reader/reading-shelf-provider.tsx";
import { readingListPath } from "@/lib/reading-shelf.ts";
import { readingShelfCopy } from "@/lib/reading-shelf-copy.ts";
import { READER_SCROLL_EVENT, readerScrollRequest } from "@/lib/reader-location.ts";


const icon = {
  search: <svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="11" cy="11" r="7" /><path d="M20 20l-4-4" /></svg>,
  bell: <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 8a6 6 0 0112 0c0 7 3 8 3 8H3s3-1 3-8" /><path d="M10.3 20a2 2 0 003.4 0" /></svg>,
  write: <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 20h9" /><path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z" /></svg>,
  account: <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2" /><circle cx="12" cy="7" r="4" /></svg>,
};

const GRAIN_TILE_SIZE = 256;
/** ScrollSmoother lag in seconds: shorter on article pages so long-form text tracks the wheel. */
const PAGE_SMOOTH = 1.2;
const READING_SMOOTH = 0.55;

/**
 * Paper grain: one 256×256 noise tile, painted once and repeated as a still
 * background behind the content. It never animates — a shifting noise layer
 * over body text reads as flicker on a long read — and it sits under the text
 * rather than over it, so glyph edges stay clean.
 */
function GrainCanvas() {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const layer = ref.current;
    if (!layer) return;
    const tile = document.createElement("canvas");
    tile.width = GRAIN_TILE_SIZE;
    tile.height = GRAIN_TILE_SIZE;
    const context = tile.getContext("2d");
    if (!context) return;
    const image = context.createImageData(GRAIN_TILE_SIZE, GRAIN_TILE_SIZE);
    image.data.set(grainTileData(GRAIN_TILE_SIZE));
    context.putImageData(image, 0, 0);
    layer.style.backgroundImage = `url(${tile.toDataURL("image/png")})`;
    layer.dataset.ready = "";
  }, []);
  return <div className="nw-grain" ref={ref} aria-hidden="true" />;
}

function SiteFooter({ locale }: { locale: Locale }) {
  const ui = getUi(locale);
  const pathname = usePathname() ?? "/";
  const onHome = pathname === "/" || pathname === "/en";
  const tool = isToolRoute(pathname);
  const home = homePath(locale);
  const topicsHref = locale === "en" ? "/en/categories" : "/categories";
  const searchHref = locale === "en" ? "/en/search" : "/search";
  const authorsHref = locale === "en" ? "/en/authors" : "/authors";
  return (
    <footer className="nw-footer" data-tool={tool ? "" : undefined}>
      {tool ? null : <div className="nw-fim">
        <img src="/covers/cover-oxblood-4x5.jpg" alt="" loading="lazy" width={1200} height={1500} />
        <div className="nw-fwm" aria-hidden="true" data-footer-letters><span className="nw-ss"><i>N</i><i>o</i></span> <span className="nw-it"><i>W</i><i>a</i><i>v</i><i>e</i></span></div>
      </div>}
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
          <Link href={readingListPath(locale)}>{readingShelfCopy(locale).title}</Link>
          <Link href={searchHref}>{ui.nav.search}</Link>
        </nav>
        <span>© {new Date().getFullYear()} {ui.footer.rights} · 简 / EN</span>
      </div>
    </footer>
  );
}

export function SiteChrome({ children }: { children: ReactNode }) {
  return <NotificationProvider><ReadingShelfProvider><SiteChromeContent>{children}</SiteChromeContent></ReadingShelfProvider></NotificationProvider>;
}

function SiteChromeContent({ children }: { children: ReactNode }) {
  const location = usePageLocation();
  const pathname = location.pathname;
  const locale = localeOf(pathname);
  const locationHref = pathname + location.search + location.hash;
  const alternateHref = alternatePath(locationHref, locale);
  const sameLanguage = localeDestination(locationHref, locale);
  const currentHref = sameLanguage.exact ? sameLanguage.href : pathname;
  const ui = getUi(locale);
  const smoothEnabled = shouldUseSmoothScroll(pathname);
  const overlays = useChromeOverlays(location);
  const { bellOpen, menuOpen } = overlays;
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
    const instance = ScrollSmoother.create({ wrapper: "#smooth-wrapper", content: "#smooth-content", smooth: isReadingRoute(window.location.pathname) ? READING_SMOOTH : PAGE_SMOOTH, effects: true });
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

  // 长文阅读时惯性要短：正文跟手，字不「漂」。其他页面保留原来的顺滑感。
  useEffect(() => {
    smoother.current?.smooth(isReadingRoute(pathname) ? READING_SMOOTH : PAGE_SMOOTH);
  }, [pathname, smoothEnabled]);

  // Reader locations are deliberate, immediate jumps, including inside transformed content.
  useEffect(() => {
    const locate = (event: Event) => {
      const request = readerScrollRequest(event);
      const instance = smoother.current;
      if (!request || request.handled || !instance) return;
      const box = request.element.getBoundingClientRect();
      if (box.height <= 0 || box.width <= 0) return;
      const destination = instance.scrollTop() + box.top + box.height * request.fraction - request.line;
      instance.scrollTop(Math.max(0, destination));
      request.handled = true;
      ScrollTrigger.update();
    };
    window.addEventListener(READER_SCROLL_EVENT, locate);
    return () => window.removeEventListener(READER_SCROLL_EVENT, locate);
  }, []);

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

  // Transfer native reveal/focus scrolling into the transform owner before focusin resets
  // the wrapper. Resetting alone moves a button between pointerdown and pointerup, losing clicks.
  useEffect(() => {
    if (!smoothEnabled) return;
    const wrapper = document.getElementById("smooth-wrapper");
    if (!wrapper) return;
    const transferNativeScroll = () => {
      const instance = smoother.current;
      if (!instance) return;
      const offset = wrapper.scrollTop;
      if (offset !== 0) {
        wrapper.scrollTop = 0;
        instance.scrollTop(Math.max(0, instance.scrollTop() + offset));
        ScrollTrigger.update();
      }
      if (wrapper.scrollLeft !== 0) wrapper.scrollLeft = 0;
    };
    wrapper.addEventListener("scroll", transferNativeScroll, { passive: true });
    wrapper.addEventListener("pointerdown", transferNativeScroll, true);
    wrapper.addEventListener("focusin", transferNativeScroll, true);
    return () => {
      wrapper.removeEventListener("scroll", transferNativeScroll);
      wrapper.removeEventListener("pointerdown", transferNativeScroll, true);
      wrapper.removeEventListener("focusin", transferNativeScroll, true);
    };
  }, [smoothEnabled]);


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
  const tool = isToolRoute(pathname);


  return (
    <>
      <a className="nw-skip" href="#top">{locale === "en" ? "Skip to main content" : "跳到正文"}</a>
      {shouldPaintGrain(pathname) ? <GrainCanvas /> : null}
      <header data-tool={tool ? "" : undefined}>
      <Link className="nw-rail" href={homePath(locale)} aria-label={`${ui.rail} — ${ui.homeAria}`}>{ui.rail}</Link>
      <nav className="nw-pill" aria-label={ui.nav.primary} lang={locale}>
        <Link className="nw-nv" href={navSelected}>{ui.nav.selected}</Link>
        <Link className="nw-nv" href={navLatest}>{ui.nav.latest}</Link>
        <Link className="nw-nv" href={navTopics} aria-current={onHome ? undefined : current(topicsHref)}>{ui.nav.topics}</Link>
        <span className="nw-sep nw-nv" aria-hidden="true" />
        <Link className="nw-nv nw-lang" onClick={overlays.onLanguageNavigate} href={locale === "en" ? alternateHref : currentHref} lang="zh-CN" aria-current={locale === "zh-CN" ? "true" : undefined}>简</Link>
        <span className="nw-nv" aria-hidden="true">/</span>
        <Link className="nw-nv nw-lang" onClick={overlays.onLanguageNavigate} href={locale === "en" ? currentHref : alternateHref} lang="en" aria-current={locale === "en" ? "true" : undefined}>EN</Link>
        <Link className="nw-ic" href={searchHref} aria-label={ui.nav.search}>{icon.search}</Link>
        <button className="nw-ic" ref={overlays.bellTrigger} type="button" aria-haspopup="dialog" aria-label={badge ? `${ui.bell.label}，${badge} ${ui.bell.unread}` : ui.bell.label} aria-expanded={bellOpen} aria-controls="nw-np" onClick={() => overlays.toggle("bell")}>
          {icon.bell}{badge ? <span className="nw-bdg" aria-live="polite">{badge}</span> : null}
        </button>
        <span className="nw-sep nw-nv" aria-hidden="true" />
        <Link className="nw-ic nw-ic-write" href="/write" aria-label={ui.nav.write} title={ui.nav.write}>{icon.write}{locale === "en" ? <span>Write</span> : null}</Link>
        <Link className="nw-ic nw-ic-account" href="/account" aria-label={ui.nav.account} title={ui.nav.account} aria-current={current("/account")}>{icon.account}</Link>
        <button className="nw-mnb" ref={overlays.menuTrigger} type="button" aria-haspopup="dialog" style={{ fontWeight: 700 }} aria-expanded={menuOpen} aria-controls="nw-menu" onClick={() => overlays.toggle("menu")}>{ui.nav.menu}</button>
      </nav>
      </header>
      <div className="nw-np" ref={overlays.bellPanel} tabIndex={-1} id="nw-np" hidden={!bellOpen} role="dialog" aria-label={ui.bell.label} lang={locale} aria-busy={bellPending}>
        <header>
          <span>{ui.bell.label}</span>
          {sessionUsable === true ? <button type="button" data-overlay-focus-key="refresh" disabled={bellPending} onClick={() => void controller.refresh()}>{locale === "en" ? "Refresh notifications" : "刷新通知"}</button> : null}
          {sessionUsable === true && bellState === "ready" && unread > 0 ? (
            <button className="nw-np-mark-all" data-overlay-focus-key="mark-all" type="button" disabled={bellPending} onClick={() => void markBellRead()}>{ui.bell.markAllRead}</button>
          ) : null}
          <button type="button" data-overlay-initial-focus data-overlay-focus-key="close" onClick={() => overlays.dismiss()}>{ui.nav.close}</button>
        </header>
        <div className="nw-np-body">
          <Link className="nw-btn" data-overlay-focus-key="inbox" href={notificationInboxPath(locale)}>{locale === "en" ? "Open notification inbox" : "打开通知收件箱"}</Link>
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
                <li className="nw-np-row" data-notification-id={item.id} key={item.id}>
                  <p className={!read ? "nw-np-text nw-np-unread" : "nw-np-text"}>{notificationPresentation(notice, locale, item.id).text}{notificationPresentation(notice, locale, item.id).href ? <> <Link data-overlay-action="view" href={notificationPresentation(notice, locale, item.id).href!}>{locale === "en" ? "View" : "查看"}</Link></> : null}</p>
                  <time className="nw-np-time" dateTime={item.createdAt}>{dateLabel(item.createdAt, locale)}</time>
                  {!read ? (
                    <button type="button" data-overlay-action="mark" disabled={bellPending} onClick={() => void markBellRead(item.id)}>{ui.bell.markRead}</button>
                  ) : null}
                </li>
              ))}
            </ul>
          ) : null}
          {sessionUsable === true && bellState === "ready" && bellCursor ? <button className="nw-btn" data-overlay-focus-key="more" type="button" disabled={bellPending} onClick={() => void loadMoreBell()}>{locale === "en" ? "Load more notifications" : "加载更多通知"}</button> : null}
        </div>
      </div>
      <div className="nw-menu" ref={overlays.menuPanel} tabIndex={-1} id="nw-menu" hidden={!menuOpen} role="dialog" aria-modal={menuOpen ? "true" : undefined} aria-label={ui.nav.menu} lang={locale}>
        <button type="button" data-overlay-initial-focus data-overlay-focus-key="close" onClick={() => overlays.dismiss()}>{ui.nav.close}</button>
        <Link href={homePath(locale)}>{ui.nav.home}</Link>
        <Link href={navSelected}>{ui.nav.selected}</Link>
        <Link href={navLatest}>{ui.nav.latest}</Link>
        <Link href={navTopics}>{ui.nav.topics}</Link>
        <Link href="/write">{ui.nav.write}</Link>
        <Link href="/account">{ui.nav.account}</Link>
        <Link href={readingListPath(locale)}>{readingShelfCopy(locale).title}</Link>
        <Link href={searchHref}>{ui.nav.search}</Link>
        <Link href={alternateHref} lang={other} aria-label={ui.nav.language}>{other === "en" ? "English" : "简体中文"}</Link>
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
