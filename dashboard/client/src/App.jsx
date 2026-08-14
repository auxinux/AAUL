import React from "react";
import { Routes, Route, Navigate } from "react-router-dom";
import AuthProvider from "./components/AuthProvider.jsx";
import ProtectedRoute from "./components/ProtectedRoute.jsx";
import Layout from "./components/Layout.jsx";
import Login from "./pages/Login.jsx";
import Dashboard from "./pages/Dashboard.jsx";
import NewAgent from "./pages/NewAgent.jsx";
import Users from "./pages/Users.jsx";
import Admin from "./pages/Admin.jsx";
import Logs from "./pages/Logs.jsx";
import AgentDetails from "./pages/AgentDetails.jsx";
import Plugins from "./pages/Plugins.jsx";
import Packages from "./pages/Packages.jsx";
import PackagesHub from "./pages/PackagesHub.jsx";
import PackagesAll from "./pages/PackagesAll.jsx";
import Tasks from "./pages/Tasks.jsx";

export default function App() {
  return (
    <AuthProvider>
      <Routes>
        <Route path="/login" element={<Login />} />
        <Route
          path="/"
          element={
            <ProtectedRoute>
              <Layout />
            </ProtectedRoute>
          }
        >
          <Route index element={<Navigate to="/dashboard" replace />} />
          <Route path="dashboard" element={<Dashboard />} />
          <Route path="packages" element={<PackagesHub />} />
          <Route path="packages/all" element={<PackagesAll />} />
          <Route path="tasks" element={<Tasks />} />
          <Route path="agents/:id" element={<AgentDetails />} />
          <Route path="agents/:id/packages" element={<Packages />} />
          <Route path="agents/new" element={<NewAgent />} />
          <Route path="logs" element={<Logs />} />
          <Route path="users" element={<Users />} />
          <Route path="admin" element={<Admin />} />
          <Route path="plugins" element={<Plugins />} />
        </Route>
        <Route path="*" element={<Navigate to="/dashboard" replace />} />
      </Routes>
    </AuthProvider>
  );
}
