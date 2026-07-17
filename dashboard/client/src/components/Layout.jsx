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
  Globe
} from "lucide-react";
import { useAuth } from "./AuthProvider.jsx";
import { useI18n } from "../lib/i18n.js";
import { apiFetch } from "../lib/api.js";
import LanguageToggle from "./LanguageToggle.jsx";
import Footer from "./Footer.jsx";
import PasswordChangeGate from "./PasswordChangeGate.jsx";

export default function Layout() {
  const { user, logout } = useAuth();
  const { t } = useI18n();
  const location = useLocation();
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [pluginNavItems, setPluginNavItems] = useState([]);
  const [topbarWidgets, setTopbarWidgets] = useState([]);
  const [hostStats, setHostStats] = useState(null);

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
      try {
        const data = await apiFetch("/api/showinfohost/stats");
        if (mounted) setHostStats(data);
      } catch {
        if (mounted) setHostStats(null);
      }
    };
    loadStats();
    const interval = setInterval(loadStats, 2000);
    return () => {
      mounted = false;
      clearInterval(interval);
    };
  }, []);

  const formatNet = (stats) => {
    if (!stats?.net || stats.net.supported === false) {
      return "-- / -- KB/s";
    }
    const rx = stats.net.rxKbps ?? 0;
    const tx = stats.net.txKbps ?? 0;
    return `${rx} / ${tx} KB/s`;
  };

  const renderWidget = (widget, idx) => {
    if (widget.type === "host-info" && widget.variant === "topbar") {
      return (
        <div key={`${widget.plugin}-${idx}`} className="glass rounded-2xl px-4 py-3 flex items-center justify-between gap-6">
          <div className="flex items-center gap-3">
             <div className="w-2 h-2 rounded-full bg-emerald-500 animate-pulse" />
             <span className="text-sm font-semibold text-white tracking-wider">
               {hostStats?.time || "--:--:--"}
             </span>
          </div>
          <div className="flex items-center gap-6 text-[11px] font-medium text-slate-400 uppercase tracking-widest">
            <div className="flex items-center gap-2">
              <Cpu size={14} className="text-brand-400" />
              <span>CPU <span className="text-slate-200">{hostStats?.cpu ?? "--"}%</span></span>
            </div>
            <div className="flex items-center gap-2">
              <Activity size={14} className="text-brand-400" />
              <span>RAM <span className="text-slate-200">{hostStats?.memPercent ?? "--"}%</span></span>
            </div>
            <div className="flex items-center gap-2">
              <Globe size={14} className="text-brand-400" />
              <span>NET <span className="text-slate-200">{formatNet(hostStats)}</span></span>
            </div>
          </div>
        </div>
      );
    }
    return null;
  };

  const navItems = useMemo(() => {
    const items = [
      { label: t("nav.dashboard"), to: "/dashboard", icon: LayoutDashboard },
      { label: t("nav.addAgent"), to: "/agents/new", icon: PlusCircle },
      { label: t("nav.packages"), to: "/packages", icon: Package },
      { label: t("nav.tasks"), to: "/tasks", icon: Clock },
      { label: t("nav.logs"), to: "/logs", icon: ClipboardList },
      { label: t("nav.users"), to: "/users", icon: Users },
      { label: t("nav.plugins"), to: "/plugins", icon: Plug },
      { label: t("nav.admin"), to: "/admin", icon: Settings }
    ];
    // Add plugin-registered nav items
    for (const p of pluginNavItems) {
      items.push({ label: p.label, href: p.href, icon: p.icon || Plug });
    }
    return items;
  }, [t, pluginNavItems]);

  return (
    <div className="min-h-screen flex flex-col">
      <PasswordChangeGate />
      
      <div className="flex-1 mx-auto w-full max-w-[1440px] flex flex-col lg:flex-row gap-0 lg:gap-8 px-0 lg:px-8 py-0 lg:py-10">
        
        {/* Sidebar */}
        <aside className={`${sidebarOpen ? 'translate-x-0' : '-translate-x-full lg:translate-x-0 lg:w-20'} fixed inset-y-0 left-0 z-40 w-72 lg:static lg:z-0 transition-all duration-300 ease-in-out`}>
          <div className="h-full glass lg:rounded-3xl flex flex-col p-6 overflow-hidden">
            {/* Logo Section */}
            <div className="mb-10 flex items-center justify-between">
              <div className={`${!sidebarOpen && 'lg:hidden'} transition-opacity duration-300`}>
                <p className="text-[10px] uppercase font-bold tracking-[0.3em] text-brand-400 mb-1">
                  {t("nav.control")}
                </p>
                <h1 className="text-xl font-bold text-white tracking-tight">
                  {t("app.name")}
                </h1>
              </div>
              <button 
                onClick={() => setSidebarOpen(!sidebarOpen)}
                className="p-2 rounded-xl hover:bg-white/5 transition-colors text-slate-400 lg:hidden"
              >
                <X size={20} />
              </button>
            </div>

            {/* Nav Items */}
            <nav className="flex flex-col gap-1.5 max-h-[calc(100vh-22rem)] overflow-y-auto no-scrollbar">
              {navItems.map((item) => {
                const Icon = item.icon;
                const isExternal = !!item.href;
                
                const linkContent = (
                  <>
                    <Icon size={18} className="shrink-0" />
                    <span className={`${!sidebarOpen && 'lg:hidden'} transition-all duration-300 truncate`}>
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
                    >
                      {linkContent}
                    </a>
                  );
                }

                return (
                  <NavLink
                    key={item.to}
                    to={item.to}
                    className={({ isActive }) =>
                      `nav-pill ${isActive ? "nav-pill-active" : "nav-pill-inactive"}`
                    }
                  >
                    {linkContent}
                  </NavLink>
                );
              })}
            </nav>

            {/* User & Logout */}
            <div className="mt-8 pt-6 border-t border-white/5 flex flex-col gap-4 shrink-0">
              <div className={`${!sidebarOpen && 'lg:hidden'} transition-opacity duration-300`}>
                <p className="text-xs text-slate-500 mb-1">Signed in as</p>
                <p className="text-sm font-semibold text-white truncate">{user?.username || "-"}</p>
              </div>
              <button 
                onClick={logout} 
                className="flex items-center gap-3 w-full px-4 py-2.5 rounded-xl text-sm font-medium text-red-400 hover:bg-red-500/10 transition-colors"
              >
                <LogOut size={18} />
                <span className={`${!sidebarOpen && 'lg:hidden'}`}>Logout</span>
              </button>
            </div>
          </div>
        </aside>

        {/* Main Content */}
        <main className="flex-1 min-w-0 p-6 lg:p-0 flex flex-col gap-6">
          {/* Top Bar */}
          <div className="flex items-center justify-between gap-4">
            <div className="flex items-center gap-4">
              {!sidebarOpen && (
                <button
                  className="p-2.5 rounded-xl glass text-slate-400 hover:text-white transition-colors"
                  onClick={() => setSidebarOpen(true)}
                >
                  <Menu size={20} />
                </button>
              )}
              {topbarWidgets.length > 0 && (
                <div className="hidden md:block">
                  {topbarWidgets.map((widget, idx) => renderWidget(widget, idx))}
                </div>
              )}
            </div>
            
            <div className="flex items-center gap-3">
              <LanguageToggle />
            </div>
          </div>

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
