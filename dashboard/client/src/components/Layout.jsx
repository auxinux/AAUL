import React, { useMemo, useState, useEffect } from "react";
import { NavLink, Outlet, useLocation } from "react-router-dom";
import {
  LayoutDashboard,
  PlusCircle,
  Package,
  Clock,
  ClipboardList,
  Users,
  Plug,
  Settings,
  LogOut,
  Menu,
  X,
  Cpu,
  Activity,
  Globe,
  PanelLeftClose,
  PanelLeftOpen,
  Terminal
} from "lucide-react";
import { useAuth } from "./AuthProvider.jsx";
import { useI18n } from "../lib/i18n.js";
import { apiFetch } from "../lib/api.js";
import LanguageToggle from "./LanguageToggle.jsx";
import Footer from "./Footer.jsx";
import PasswordChangeGate from "./PasswordChangeGate.jsx";

const COLLAPSE_STORAGE_KEY = "aaul.sidebarCollapsed";

// Lucide icons a plugin may request by name in its registerUI("nav:item") call.
// Kept as an explicit map so the bundle only pulls in what we actually ship.
const PLUGIN_ICON_BY_NAME = {
  Terminal,
  Console: Terminal,
  Monitor: Cpu,
  Activity,
  Globe,
  Settings,
  Plug
};

/**
 * Normalize whatever a plugin put in `icon`.
 *
 * Returns `{ Component }` for a real icon, or `{ text }` for an emoji/short
 * label rendered in the icon slot. Anything unusable falls back to a plug icon,
 * so a nav entry is never left without a glyph.
 */
function resolveNavIcon(icon) {
  if (typeof icon === "function") {
    return { Component: icon };
  }
  if (typeof icon === "string" && icon.trim()) {
    const named = PLUGIN_ICON_BY_NAME[icon.trim()];
    if (named) {
      return { Component: named };
    }
    // Emoji or other short glyph: render it as text in the icon slot.
    if ([...icon.trim()].length <= 2) {
      return { text: icon.trim() };
    }
  }
  return { Component: Plug };
}

// The host widget refreshes on a timer. 2 s was fine on a desktop tab, but on a
// phone it is a request every two seconds against the battery for a number
// nobody is watching — 5 s reads the same and costs less.
const HOST_STATS_INTERVAL_MS = 5000;

export default function Layout() {
  const { user, logout } = useAuth();
  const { t } = useI18n();
  const location = useLocation();

  // Two independent states, because they are two different things:
  //  - `mobileNavOpen` is a drawer overlaying the page on small screens, and
  //    must start CLOSED or the app opens with its own menu covering it;
  //  - `desktopCollapsed` is the icons-only rail on large screens, remembered
  //    across sessions because it is a lasting preference, not a transient one.
  const [mobileNavOpen, setMobileNavOpen] = useState(false);
  const [desktopCollapsed, setDesktopCollapsed] = useState(() => {
    if (typeof window === "undefined") return false;
    return window.localStorage.getItem(COLLAPSE_STORAGE_KEY) === "true";
  });

  const [pluginNavItems, setPluginNavItems] = useState([]);
  const [topbarWidgets, setTopbarWidgets] = useState([]);
  const [hostStats, setHostStats] = useState(null);

  const toggleDesktopCollapsed = () => {
    setDesktopCollapsed((collapsed) => {
      const next = !collapsed;
      if (typeof window !== "undefined") {
        window.localStorage.setItem(COLLAPSE_STORAGE_KEY, String(next));
      }
      return next;
    });
  };

  // Navigating on a phone should reveal the page you just asked for, not leave
  // the drawer sitting on top of it.
  useEffect(() => {
    setMobileNavOpen(false);
  }, [location.pathname]);

  // While the drawer is open it owns the screen; letting the page scroll behind
  // it is the classic mobile-menu bug.
  useEffect(() => {
    if (typeof document === "undefined") return undefined;
    document.body.style.overflow = mobileNavOpen ? "hidden" : "";
    return () => {
      document.body.style.overflow = "";
    };
  }, [mobileNavOpen]);

  // Escape closes the drawer — expected of any overlay.
  useEffect(() => {
    if (!mobileNavOpen) return undefined;
    const onKeyDown = (event) => {
      if (event.key === "Escape") setMobileNavOpen(false);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [mobileNavOpen]);

  // Fetch plugin-registered nav items
  useEffect(() => {
    apiFetch("/api/plugins/ui/nav:item")
      .then((data) => {
        if (data.ok && Array.isArray(data.components)) {
          const items = data.components.filter(
            (item) => !item.adminOnly || user?.isAdmin
          );
          setPluginNavItems(items);
        }
      })
      .catch(() => {});
  }, [user?.isAdmin]);

  useEffect(() => {
    apiFetch("/api/plugins/ui/layout:topbar")
      .then((data) => {
        if (data.ok && Array.isArray(data.components)) {
          setTopbarWidgets(data.components);
        }
      })
      .catch(() => setTopbarWidgets([]));
  }, []);

  useEffect(() => {
    let mounted = true;
    const loadStats = async () => {
      // Polling a background tab is wasted work and, on mobile, wasted battery.
      if (typeof document !== "undefined" && document.hidden) return;
      try {
        const data = await apiFetch("/api/showinfohost/stats");
        if (mounted) setHostStats(data);
      } catch {
        if (mounted) setHostStats(null);
      }
    };
    loadStats();
    const interval = setInterval(loadStats, HOST_STATS_INTERVAL_MS);
    return () => {
      mounted = false;
      clearInterval(interval);
    };
  }, []);

  const formatNet = (stats) => {
    if (!stats?.net || stats.net.supported === false) {
      return "-- / --";
    }
    const rx = stats.net.rxKbps ?? 0;
    const tx = stats.net.txKbps ?? 0;
    return `${rx} / ${tx} KB/s`;
  };

  const renderWidget = (widget, idx) => {
    if (widget.type !== "host-info" || widget.variant !== "topbar") {
      return null;
    }
    return (
      <div
        key={`${widget.plugin}-${idx}`}
        className="glass rounded-2xl px-3 sm:px-4 py-2.5 flex items-center gap-4 sm:gap-6 overflow-x-auto no-scrollbar"
      >
        <div className="flex items-center gap-2 shrink-0">
          <div className="w-2 h-2 rounded-full bg-emerald-500 animate-pulse" />
          <span className="text-sm font-semibold text-white tracking-wider tabular-nums">
            {hostStats?.time || "--:--:--"}
          </span>
        </div>
        <div className="flex items-center gap-4 sm:gap-6 text-[11px] font-medium text-slate-400 uppercase tracking-widest shrink-0">
          <div className="flex items-center gap-2">
            <Cpu size={14} className="text-brand-400" />
            <span>CPU <span className="text-slate-200 tabular-nums">{hostStats?.cpu ?? "--"}%</span></span>
          </div>
          <div className="flex items-center gap-2">
            <Activity size={14} className="text-brand-400" />
            <span>RAM <span className="text-slate-200 tabular-nums">{hostStats?.memPercent ?? "--"}%</span></span>
          </div>
          {/* Network is the least critical of the three: first to go on a phone. */}
          <div className="hidden sm:flex items-center gap-2">
            <Globe size={14} className="text-brand-400" />
            <span>NET <span className="text-slate-200 tabular-nums">{formatNet(hostStats)}</span></span>
          </div>
        </div>
      </div>
    );
  };

  const navItems = useMemo(() => {
    const items = [
      { label: t("nav.dashboard"), to: "/dashboard", Component: LayoutDashboard },
      { label: t("nav.addAgent"), to: "/agents/new", Component: PlusCircle },
      { label: t("nav.packages"), to: "/packages", Component: Package },
      { label: t("nav.tasks"), to: "/tasks", Component: Clock },
      { label: t("nav.logs"), to: "/logs", Component: ClipboardList },
      { label: t("nav.users"), to: "/users", Component: Users },
      { label: t("nav.plugins"), to: "/plugins", Component: Plug },
      { label: t("nav.admin"), to: "/admin", Component: Settings }
    ];
    for (const p of pluginNavItems) {
      items.push({ label: p.label, href: p.href, ...resolveNavIcon(p.icon) });
    }
    return items;
  }, [t, pluginNavItems]);

  // On desktop the collapsed rail hides labels; on mobile the drawer is always
  // full-width, so labels are always shown there.
  const labelClass = desktopCollapsed ? "lg:hidden" : "";

  return (
    <div className="min-h-screen flex flex-col">
      <PasswordChangeGate />

      {/* Mobile header: always reachable, so the menu is never trapped. */}
      <header className="lg:hidden sticky top-0 z-30 safe-top glass border-b border-white/5">
        <div className="flex items-center justify-between gap-3 px-4 py-3">
          <button
            type="button"
            className="p-2 -ml-2 rounded-xl text-slate-300 hover:bg-white/5 transition-colors"
            onClick={() => setMobileNavOpen(true)}
            aria-label={t("nav.showMenu")}
            aria-expanded={mobileNavOpen}
          >
            <Menu size={22} />
          </button>
          <div className="min-w-0 text-center">
            <p className="text-[9px] uppercase font-bold tracking-[0.3em] text-brand-400 leading-none">
              {t("nav.control")}
            </p>
            <h1 className="text-sm font-bold text-white truncate">{t("app.shortName")}</h1>
          </div>
          <LanguageToggle />
        </div>
      </header>

      <div className="flex-1 mx-auto w-full max-w-[1440px] flex flex-col lg:flex-row gap-0 lg:gap-8 px-0 lg:px-8 py-0 lg:py-10">

        {/* Backdrop: tapping outside the drawer closes it. */}
        {mobileNavOpen && (
          <div
            className="fixed inset-0 z-40 bg-black/70 backdrop-blur-sm lg:hidden animate-fade-in"
            onClick={() => setMobileNavOpen(false)}
            aria-hidden="true"
          />
        )}

        {/* Sidebar: an off-canvas drawer on mobile, a static column on desktop. */}
        <aside
          className={`${mobileNavOpen ? "translate-x-0" : "-translate-x-full"} ${
            desktopCollapsed ? "lg:w-20" : "lg:w-72"
          } fixed inset-y-0 left-0 z-50 w-[85vw] max-w-xs lg:static lg:z-0 lg:translate-x-0 lg:shrink-0 transition-transform duration-300 ease-in-out`}
          aria-label={t("nav.control")}
        >
          <div className="h-full glass lg:rounded-3xl flex flex-col p-5 sm:p-6 overflow-hidden safe-top safe-bottom">
            {/* Logo Section */}
            <div className="mb-8 flex items-center justify-between gap-2">
              <div className={`${labelClass} min-w-0 transition-opacity duration-300`}>
                <p className="text-[10px] uppercase font-bold tracking-[0.3em] text-brand-400 mb-1">
                  {t("nav.control")}
                </p>
                <h1 className="text-lg font-bold text-white tracking-tight truncate">
                  {t("app.name")}
                </h1>
              </div>
              <button
                type="button"
                onClick={() => setMobileNavOpen(false)}
                className="p-2 rounded-xl hover:bg-white/5 transition-colors text-slate-400 lg:hidden shrink-0"
                aria-label={t("nav.hide")}
              >
                <X size={20} />
              </button>
              <button
                type="button"
                onClick={toggleDesktopCollapsed}
                className="hidden lg:flex p-2 rounded-xl hover:bg-white/5 transition-colors text-slate-400 shrink-0"
                aria-label={desktopCollapsed ? t("nav.showMenu") : t("nav.hide")}
                title={desktopCollapsed ? t("nav.showMenu") : t("nav.hide")}
              >
                {desktopCollapsed ? <PanelLeftOpen size={18} /> : <PanelLeftClose size={18} />}
              </button>
            </div>

            {/* Nav Items — flex-1 lets the list take the space actually left over
                instead of a hardcoded viewport calculation that breaks as soon as
                a plugin adds a nav entry. */}
            <nav className="flex flex-col gap-1.5 min-h-0 overflow-y-auto no-scrollbar -mx-1 px-1">
              {navItems.map((item) => {
                const Icon = item.Component;
                const isExternal = Boolean(item.href);

                const linkContent = (
                  <>
                    {Icon ? (
                      <Icon size={18} className="shrink-0" />
                    ) : (
                      <span
                        className="shrink-0 w-[18px] text-center text-base leading-none"
                        aria-hidden="true"
                      >
                        {item.text}
                      </span>
                    )}
                    <span className={`${labelClass} transition-all duration-300 truncate`}>
                      {item.label}
                    </span>
                  </>
                );

                if (isExternal) {
                  return (
                    <a
                      key={item.href}
                      href={item.href}
                      className="nav-pill nav-pill-inactive"
                      title={desktopCollapsed ? item.label : undefined}
                    >
                      {linkContent}
                    </a>
                  );
                }

                return (
                  <NavLink
                    key={item.to}
                    to={item.to}
                    title={desktopCollapsed ? item.label : undefined}
                    className={({ isActive }) =>
                      `nav-pill ${isActive ? "nav-pill-active" : "nav-pill-inactive"}`
                    }
                  >
                    {linkContent}
                  </NavLink>
                );
              })}
            </nav>

            {/* User & Logout — sits right under the last menu entry rather than
                being pinned to the bottom of the sidebar. */}
            <div className="mt-5 pt-5 border-t border-white/5 flex flex-col gap-3 shrink-0">
              <div className={`${labelClass} transition-opacity duration-300 min-w-0`}>
                <p className="text-xs text-slate-500 mb-0.5">{t("nav.signedInAs")}</p>
                <p className="text-sm font-semibold text-white truncate">{user?.username || "—"}</p>
              </div>
              <button
                type="button"
                onClick={logout}
                className="flex items-center gap-3 w-full px-4 py-2.5 rounded-xl text-sm font-medium text-red-400 hover:bg-red-500/10 transition-colors"
                title={desktopCollapsed ? t("nav.logout") : undefined}
              >
                <LogOut size={18} className="shrink-0" />
                <span className={labelClass}>{t("nav.logout")}</span>
              </button>
            </div>

            {/* Absorbs the leftover height so nothing is pinned to the bottom. */}
            <div className="flex-1" aria-hidden="true" />
          </div>
        </aside>

        {/* Main Content */}
        <main className="flex-1 min-w-0 p-4 sm:p-6 lg:p-0 flex flex-col gap-5 sm:gap-6 safe-bottom">
          {/* Desktop top bar. On mobile the sticky header above already covers
              navigation and language, so this row only appears from lg up. */}
          {topbarWidgets.length > 0 && (
            <div className="hidden lg:flex items-center justify-between gap-4">
              <div className="min-w-0">
                {topbarWidgets.map((widget, idx) => renderWidget(widget, idx))}
              </div>
              <LanguageToggle />
            </div>
          )}
          {topbarWidgets.length === 0 && (
            <div className="hidden lg:flex items-center justify-end">
              <LanguageToggle />
            </div>
          )}

          {/* Page Content */}
          <div className="flex-1 animate-fade-in">
            <Outlet />
          </div>

          <Footer />
        </main>
      </div>
    </div>
  );
}
