import { BrowserRouter, Navigate, Route, Routes } from 'react-router';
import { I18nProvider } from './lib/i18n';
import { AuthProvider, useAuth } from './lib/auth';
import { Layout } from './components/Layout';
import { Spinner, ToastProvider } from './components/ui';
import { Login } from './pages/Login';
import { ResourceDetailPage, ResourceListPage } from './pages/ResourcePages';
import { ProjectDetailPage, ProjectsPage } from './pages/ProjectPages';
import { ApprovalsPage, Dashboard, MyTasksPage } from './pages/WorkPages';
import { TimesheetPage } from './pages/TimesheetPage';
import { ReceivingPage, StockPage } from './pages/WarehousePages';
import { ExportCenter, ImportPage } from './pages/DataPages';
import { AuditPage, ProfilePage, SettingsPage } from './pages/SettingsPage';
import { DocumentsPanel } from './components/Documents';
import { PageHead } from './components/ui';
import { useI18n } from './lib/i18n';

function DocumentsPage() {
  const { t } = useI18n();
  return <><PageHead title={t('r.documents')} sub={t('mod.engineering')} /><DocumentsPanel /></>;
}

function Gate() {
  const { session, loading } = useAuth();
  if (loading) return <Spinner />;
  if (!session) return <Login />;
  return (
    <Routes>
      <Route element={<Layout />}>
        <Route index element={<Dashboard />} />
        <Route path="my-tasks" element={<MyTasksPage />} />
        <Route path="approvals" element={<ApprovalsPage />} />
        <Route path="timesheets" element={<TimesheetPage />} />
        <Route path="projects" element={<ProjectsPage />} />
        <Route path="projects/:id" element={<ProjectDetailPage />} />
        <Route path="r/documents" element={<DocumentsPage />} />
        <Route path="r/projects" element={<Navigate to="/projects" replace />} />
        <Route path="r/:key" element={<ResourceListPage />} />
        <Route path="r/:key/:id" element={<ResourceDetailPage />} />
        <Route path="warehouse/receiving" element={<ReceivingPage />} />
        <Route path="warehouse/stock" element={<StockPage />} />
        <Route path="exports" element={<ExportCenter />} />
        <Route path="import" element={<ImportPage />} />
        <Route path="settings" element={<SettingsPage />} />
        <Route path="audit" element={<AuditPage />} />
        <Route path="profile" element={<ProfilePage />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Route>
    </Routes>
  );
}

export default function App() {
  return (
    <I18nProvider>
      <ToastProvider>
        <AuthProvider>
          <BrowserRouter>
            <Gate />
          </BrowserRouter>
        </AuthProvider>
      </ToastProvider>
    </I18nProvider>
  );
}
