import { useState, useEffect } from 'react';
import { X } from 'lucide-react';
import {
  getFolderPermissions,
  setFolderPermission,
  getRAGAssignments,
  setRAGAssignment,
} from '../services/permissions.service';

interface FolderPermissionsModalProps {
  folderId: string;
  folderName: string;
  onClose: () => void;
}

type Role = 'student' | 'docent' | 'admin';
type ModuleType = 'general' | 'explain' | 'project' | 'quiz';

export default function FolderPermissionsModal({ folderId, folderName, onClose }: FolderPermissionsModalProps) {
  const [permissions, setPermissions] = useState<Record<Role, { canView: boolean; canEdit: boolean }>>({
    student: { canView: false, canEdit: false },
    docent: { canView: false, canEdit: false },
    admin: { canView: true, canEdit: true },
  });

  const [ragAssignments, setRagAssignments] = useState<Record<ModuleType, boolean>>({
    general: false,
    explain: false,
    project: false,
    quiz: false,
  });

  const [saving, setSaving] = useState(false);

  useEffect(() => {
    loadPermissions();
    loadRAGAssignments();
  }, [folderId]);

  async function loadPermissions() {
    try {
      const perms = await getFolderPermissions(folderId);
      const newPermissions = { ...permissions };

      perms.forEach(perm => {
        newPermissions[perm.role as Role] = {
          canView: perm.can_view,
          canEdit: perm.can_edit,
        };
      });

      setPermissions(newPermissions);
    } catch (error) {
      console.error('Error loading permissions:', error);
    }
  }

  async function loadRAGAssignments() {
    try {
      const assignments = await getRAGAssignments(folderId);
      const newAssignments = { ...ragAssignments };

      assignments.forEach(assignment => {
        newAssignments[assignment.module_type as ModuleType] = assignment.is_active;
      });

      setRagAssignments(newAssignments);
    } catch (error) {
      console.error('Error loading RAG assignments:', error);
    }
  }

  async function handleSave() {
    setSaving(true);
    try {
      await Promise.all([
        setFolderPermission(folderId, 'student', permissions.student.canView, permissions.student.canEdit),
        setFolderPermission(folderId, 'docent', permissions.docent.canView, permissions.docent.canEdit),
        setRAGAssignment(folderId, 'general', ragAssignments.general),
        setRAGAssignment(folderId, 'explain', ragAssignments.explain),
        setRAGAssignment(folderId, 'project', ragAssignments.project),
        setRAGAssignment(folderId, 'quiz', ragAssignments.quiz),
      ]);
      onClose();
    } catch (error) {
      console.error('Error saving permissions:', error);
      alert('Fout bij opslaan van instellingen');
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center p-4 z-50">
      <div className="bg-white rounded-lg shadow-xl max-w-2xl w-full">
        <div className="flex items-center justify-between p-6 border-b">
          <h2 className="text-xl font-semibold">Toegang Beheren: {folderName}</h2>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-600">
            <X className="w-5 h-5" />
          </button>
        </div>

        <div className="p-6 space-y-6">
          <div>
            <h3 className="font-semibold mb-3">Rol Toegang</h3>
            <div className="space-y-3">
              {(['student', 'docent'] as Role[]).map(role => (
                <div key={role} className="flex items-center justify-between p-3 border rounded">
                  <span className="font-medium capitalize">{role}</span>
                  <div className="flex gap-4">
                    <label className="flex items-center gap-2">
                      <input
                        type="checkbox"
                        checked={permissions[role].canView}
                        onChange={(e) =>
                          setPermissions({
                            ...permissions,
                            [role]: { ...permissions[role], canView: e.target.checked },
                          })
                        }
                        className="rounded"
                      />
                      <span className="text-sm">Kan bekijken</span>
                    </label>
                    {role === 'docent' && (
                      <label className="flex items-center gap-2">
                        <input
                          type="checkbox"
                          checked={permissions[role].canEdit}
                          onChange={(e) =>
                            setPermissions({
                              ...permissions,
                              [role]: { ...permissions[role], canEdit: e.target.checked },
                            })
                          }
                          className="rounded"
                        />
                        <span className="text-sm">Kan bewerken</span>
                      </label>
                    )}
                  </div>
                </div>
              ))}
              <div className="p-3 bg-gray-50 rounded text-sm text-gray-600">
                Admins hebben altijd volledige toegang
              </div>
            </div>
          </div>

          <div>
            <h3 className="font-semibold mb-3">Chat Module Toewijzingen</h3>
            <p className="text-sm text-gray-600 mb-3">
              Selecteer in welke chat modules deze documenten gebruikt worden voor RAG
            </p>
            <div className="space-y-2">
              {[
                { key: 'general' as ModuleType, label: 'Algemene Chat' },
                { key: 'explain' as ModuleType, label: 'Ik Leg Uit' },
                { key: 'project' as ModuleType, label: 'Project Begeleiding' },
                { key: 'quiz' as ModuleType, label: 'Quiz' },
              ].map(module => (
                <label key={module.key} className="flex items-center gap-3 p-3 border rounded hover:bg-gray-50 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={ragAssignments[module.key]}
                    onChange={(e) =>
                      setRagAssignments({
                        ...ragAssignments,
                        [module.key]: e.target.checked,
                      })
                    }
                    className="rounded"
                  />
                  <span>{module.label}</span>
                </label>
              ))}
            </div>
          </div>
        </div>

        <div className="flex justify-end gap-3 p-6 border-t">
          <button
            onClick={onClose}
            className="px-4 py-2 text-gray-700 hover:bg-gray-100 rounded-md"
          >
            Annuleren
          </button>
          <button
            onClick={handleSave}
            disabled={saving}
            className="px-4 py-2 bg-blue-600 text-white rounded-md hover:bg-blue-700 disabled:opacity-50"
          >
            {saving ? 'Opslaan...' : 'Opslaan'}
          </button>
        </div>
      </div>
    </div>
  );
}
