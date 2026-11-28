import { lazy, Suspense, useEffect, useState } from 'react';
import {
  Navigate,
  NavLink,
  Route,
  Routes,
  useLocation,
} from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import {
  BookOpen,
  ClipboardCheck,
  FolderOpen,
  GraduationCap,
  House,
  LogOut,
  Moon,
  Sun,
  Users,
} from 'lucide-react';
import { readAuth, saveAuth } from './storage';
import type { Auth } from './types';
import { useMocks } from './services';
import { PageTitle } from './ui';

const Login = lazy(() => import('./pages/Login'));
const Student = lazy(() => import('./pages/Student'));
const Staff = lazy(() => import('./pages/Staff'));
const Demo = lazy(() => import('./pages/Demo'));
const Materials = lazy(() => import('./pages/Materials'));
const UserManagement = lazy(() => import('./pages/Users'));
const Marks = lazy(() => import('./pages/Marks'));

const nav = {
  home: ['/', 'Overview', House],
  courses: ['/courses', 'Courses', BookOpen],
  attendance: ['/attendance', 'Attendance', ClipboardCheck],
  materials: ['/materials', 'Materials', FolderOpen],
  marks: ['/marks', 'Marks', GraduationCap],
  users: ['/users', 'Users', Users],
} as const;
const byRole = {
  student: [nav.home, nav.courses, nav.attendance, nav.materials, nav.marks],
  teacher: [nav.home, nav.courses, nav.attendance, nav.materials, nav.marks],
  admin: [nav.home, nav.courses, nav.materials, nav.users],
};

export default function App() {
  const [auth, setAuth] = useState(readAuth);
  const [expired, setExpired] = useState(false);
  const [theme, setTheme] = useState(
    () =>
      localStorage.getItem('campusos.theme') ??
      (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'),
  );
  const client = useQueryClient();
  const location = useLocation();
  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    localStorage.setItem('campusos.theme', theme);
  }, [theme]);
  useEffect(() => {
    const onExpired = () => {
      saveAuth(null);
      setAuth(null);
      setExpired(true);
      client.clear();
    };
    window.addEventListener('campusos:expired', onExpired);
    return () => window.removeEventListener('campusos:expired', onExpired);
  }, [client]);
  useEffect(() => {
    window.scrollTo(0, 0);
  }, [location.pathname]);
  function updateAuth(value: Auth | null) {
    saveAuth(value);
    client.clear();
    setAuth(value);
    setExpired(false);
  }
  const themeButton = (
    <button
      className="icon-button"
      onClick={() => setTheme(theme === 'dark' ? 'light' : 'dark')}
      aria-label={
        theme === 'dark' ? 'Switch to light theme' : 'Switch to dark theme'
      }
    >
      {theme === 'dark' ? <Sun size={19} /> : <Moon size={19} />}
    </button>
  );
  if (!auth)
    return (
      <Suspense fallback={<p role="status">Loading…</p>}>
        <Login
          onLogin={updateAuth}
          themeButton={themeButton}
          expired={expired}
        />
      </Suspense>
    );

  const { user } = auth;
  const initials = user.full_name
    .split(/\s+/)
    .slice(0, 2)
    .map((part) => part[0])
    .join('');
  const portal =
    user.role === 'student' ? <Student user={user} /> : <Staff user={user} />;
  const deny = (
    <PageTitle
      label="403"
      title="Access denied"
      detail="Your account does not have access to this page."
    />
  );
  return (
    <div className="app">
      <a className="skip" href="#content">
        Skip to content
      </a>
      <header className="topbar glass">
        <NavLink to="/" className="brand">
          <span className="brand-icon">
            <GraduationCap size={22} />
          </span>
          CampusOS
        </NavLink>
        <div className="header-actions">
          {useMocks && <span className="badge mock">Demo data</span>}
          {themeButton}
          <span className="avatar" title={user.full_name}>
            {initials}
          </span>
          <button
            className="icon-button"
            onClick={() => updateAuth(null)}
            aria-label="Sign out"
          >
            <LogOut size={18} />
          </button>
        </div>
      </header>
      <nav className="nav glass" aria-label="Main">
        <div className="nav-caption">Workspace</div>
        {byRole[user.role].map(([to, label, Icon]) => (
          <NavLink end key={to} to={to}>
            <Icon size={19} />
            <span>{label}</span>
          </NavLink>
        ))}
        <div className="nav-user">
          <strong>{user.full_name}</strong>
          <span>{user.role}</span>
        </div>
      </nav>
      <main id="content" className="main">
        <Suspense
          fallback={
            <div className="card skeleton" role="status">
              Loading…
            </div>
          }
        >
          <Routes>
            <Route path="/" element={portal} />
            <Route path="/courses" element={portal} />
            <Route
              path="/attendance"
              element={user.role === 'admin' ? deny : portal}
            />
            <Route
              path="/materials"
              element={
                useMocks ? (
                  <Demo key="materials" type="materials" role={user.role} />
                ) : (
                  <Materials role={user.role} />
                )
              }
            />
            <Route
              path="/marks"
              element={
                user.role === 'admin' ? (
                  deny
                ) : useMocks ? (
                  <Demo key="marks" type="marks" role={user.role} />
                ) : (
                  <Marks teacher={user.role === 'teacher'} />
                )
              }
            />
            <Route
              path="/users"
              element={
                user.role !== 'admin' ? (
                  deny
                ) : useMocks ? (
                  <Demo type="users" role={user.role} />
                ) : (
                  <UserManagement />
                )
              }
            />
            <Route path="/login" element={<Navigate to="/" replace />} />
            <Route
              path="*"
              element={
                <PageTitle
                  label="404"
                  title="Page not found"
                  detail="Choose a page from the navigation to continue."
                />
              }
            />
          </Routes>
        </Suspense>
      </main>
    </div>
  );
}
