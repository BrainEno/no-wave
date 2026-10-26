"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import type { Locale } from "@/lib/content.ts";
import { archivePath, homePath } from "@/lib/content.ts";
import type { HomeCopy } from "./home-copy.ts";
import { editionLabel } from "./home-copy.ts";
import styles from "../home-page.module.css";

export function HomeNav({ locale, copy }: { locale: Locale; copy: HomeCopy }) {
  const english = locale === "en";
  const edition = editionLabel();
  const railLabel = copy.railLabel(edition);
  const archiveHref = archivePath(locale);
  const [notificationsOpen, setNotificationsOpen] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [allRead, setAllRead] = useState(false);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setNotificationsOpen(false);
        setMenuOpen(false);
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  return (
    <>
      <a className={styles.rail} href="#top" aria-label={copy.railHomeLabel}>
        {railLabel}
      </a>

      <nav className={styles.pill} aria-label={english ? "Primary navigation" : "主导航"}>
        <a className={styles.navLink} href="#selected">
          {copy.navSelected}
        </a>
        <a className={styles.navLink} href="#latest">
          {copy.navBlog}
        </a>
        <a className={styles.navLink} href="#topics">
          {copy.navTopics}
        </a>
        <span className={styles.sep} aria-hidden="true" />
        <Link
          className={styles.langLink}
          href={homePath("zh-CN")}
          lang="zh-CN"
          aria-current={!english ? "page" : undefined}
        >
          简
        </Link>
        <span className={styles.langSlash} aria-hidden="true">
          /
        </span>
        <Link
          className={styles.langLink}
          href={homePath("en")}
          lang="en"
          aria-current={english ? "page" : undefined}
        >
          EN
        </Link>
        <Link className={styles.iconButton} href={archiveHref} aria-label={copy.searchLabel}>
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
            <circle cx="11" cy="11" r="7" />
            <path d="M20 20l-4-4" />
          </svg>
        </Link>
        <button
          type="button"
          className={styles.iconButton}
          aria-label={allRead ? copy.bellReadLabel : copy.bellUnreadLabel}
          aria-expanded={notificationsOpen}
          aria-controls="home-notifications"
          onClick={() => {
            setMenuOpen(false);
            setNotificationsOpen((open) => !open);
          }}
        >
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="M6 8a6 6 0 0112 0c0 7 3 8 3 8H3s3-1 3-8" />
            <path d="M10.3 20a2 2 0 003.4 0" />
          </svg>
          {!allRead ? (
            <span className={styles.badge} aria-hidden="true">
              {copy.notifications.length}
            </span>
          ) : null}
        </button>
        <button
          type="button"
          className={styles.menuButton}
          aria-expanded={menuOpen}
          aria-controls="home-menu"
          onClick={() => {
            setNotificationsOpen(false);
            setMenuOpen(true);
          }}
        >
          {copy.menuButton}
        </button>
      </nav>

      <div className={styles.notifyPanel} id="home-notifications" hidden={!notificationsOpen}>
        <header>
          <span>{copy.notificationsTitle}</span>
          <button
            type="button"
            onClick={() => {
              setAllRead(true);
              setNotificationsOpen(false);
            }}
          >
            {copy.markAllRead}
          </button>
        </header>
        {copy.notifications.map((item) => (
          <a href="#latest" key={item} onClick={() => setNotificationsOpen(false)}>
            {item}
          </a>
        ))}
      </div>

      <div className={styles.menu} id="home-menu" hidden={!menuOpen}>
        <button type="button" onClick={() => setMenuOpen(false)}>
          {copy.menuClose}
        </button>
        <a href="#top" onClick={() => setMenuOpen(false)}>
          {copy.menuHome}
        </a>
        <a href="#selected" onClick={() => setMenuOpen(false)}>
          {copy.menuSelected}
        </a>
        <a href="#latest" onClick={() => setMenuOpen(false)}>
          {copy.menuLatest}
        </a>
        <a href="#topics" onClick={() => setMenuOpen(false)}>
          {copy.menuTopics}
        </a>
      </div>
    </>
  );
}
