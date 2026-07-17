import React, { useEffect, useState } from "react";
import { apiFetch } from "../lib/api.js";
import Modal from "../components/Modal.jsx";
import ConfirmDialog from "../components/ConfirmDialog.jsx";
import { useI18n } from "../lib/i18n.js";

export default function Users() {
  const { t, lang } = useI18n();
  const [users, setUsers] = useState([]);
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const [modalUser, setModalUser] = useState(null);
  const [modalPassword, setModalPassword] = useState("");
  const [deleteUserTarget, setDeleteUserTarget] = useState(null);

  const loadUsers = async () => {
    setLoading(true);
    setError("");
    try {
      const data = await apiFetch("/api/users");
      setUsers(data.users || []);
    } catch (err) {
      setError(err.message || t("errors.loadUsers"));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadUsers();
  }, []);

  const createUser = async (event) => {
    event.preventDefault();
    setError("");
    try {
      await apiFetch("/api/users", {
        method: "POST",
        body: JSON.stringify({ username, password })
      });
      setUsername("");
      setPassword("");
      await loadUsers();
    } catch (err) {
      setError(err.message || t("errors.createUser"));
    }
  };

  const openPasswordModal = (user) => {
    setModalUser(user);
    setModalPassword("");
  };

  const updatePassword = async () => {
    if (!modalUser) {
      return;
    }
    await apiFetch(`/api/users/${modalUser.id}/password`, {
      method: "PUT",
      body: JSON.stringify({ password: modalPassword })
    });
    setModalUser(null);
  };

  const deleteUser = async (user) => {
    await apiFetch(`/api/users/${user.id}`, { method: "DELETE" });
    setDeleteUserTarget(null);
    await loadUsers();
  };

  return (
    <div className="space-y-6">
      <div className="card">
        <h2 className="text-2xl font-semibold text-white">{t("users.title")}</h2>
        <p className="text-sm text-slate-400">{t("users.subtitle")}</p>
      </div>

      <div className="card">
        <form onSubmit={createUser} className="space-y-4">
          <div className="grid gap-4 md:grid-cols-2">
            <input
              className="input"
              placeholder={t("login.username")}
              value={username}
              onChange={(event) => setUsername(event.target.value)}
            />
            <input
              className="input"
              placeholder={t("login.password")}
              type="password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
            />
          </div>
          {error ? <p className="text-sm text-red-400">{error}</p> : null}
          <button className="btn btn-primary" type="submit">
            {t("users.create")}
          </button>
        </form>
      </div>

      <div className="card">
        {loading ? <p className="text-sm text-slate-400">{t("users.loading")}</p> : null}
        <table className="min-w-full text-sm">
          <thead className="text-left text-slate-400">
            <tr>
              <th className="py-3">{t("login.username")}</th>
              <th className="py-3">{t("users.created")}</th>
              <th className="py-3">{t("users.actions")}</th>
            </tr>
          </thead>
          <tbody>
            {users.map((user) => (
              <tr key={user.id} className="table-row">
                <td className="py-4 text-white">{user.username}</td>
                <td className="py-4 text-slate-400">
                  {new Date(user.created_at).toLocaleString(lang)}
                </td>
                <td className="py-4">
                  <div className="flex flex-wrap gap-2">
                    <button
                      className="btn btn-secondary"
                      onClick={() => openPasswordModal(user)}
                    >
                      {t("users.setPassword")}
                    </button>
                    <button
                      className="btn btn-danger"
                      onClick={() => setDeleteUserTarget(user)}
                    >
                      {t("users.delete")}
                    </button>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <Modal
        open={Boolean(modalUser)}
        title={t("users.modalTitle", { name: modalUser?.username || "" })}
        onClose={() => setModalUser(null)}
      >
        <div className="space-y-4">
          <input
            className="input"
            placeholder={t("users.newPassword")}
            type="password"
            value={modalPassword}
            onChange={(event) => setModalPassword(event.target.value)}
          />
          <div className="flex justify-end gap-3">
            <button className="btn btn-secondary" onClick={() => setModalUser(null)}>
              {t("common.cancel")}
            </button>
            <button
              className="btn btn-primary"
              onClick={updatePassword}
              disabled={!modalPassword}
            >
              {t("users.save")}
            </button>
          </div>
        </div>
      </Modal>

      <ConfirmDialog
        open={Boolean(deleteUserTarget)}
        title={t("users.delete")}
        description={
          deleteUserTarget ? t("confirm.deleteUser", { name: deleteUserTarget.username }) : ""
        }
        confirmLabel={t("users.delete")}
        tone="danger"
        onClose={() => setDeleteUserTarget(null)}
        onConfirm={() => deleteUser(deleteUserTarget)}
      />
    </div>
  );
}
