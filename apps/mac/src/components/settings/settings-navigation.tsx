import {
  FolderIcon,
  UsersIcon,
  RefreshCwIcon,
  DownloadIcon,
  MonitorIcon,
  UserIcon,
  ShieldUserIcon,
  PlugIcon,
} from "lucide-react";
import type { Project } from "../../types.js";
import { projectLabel } from "../project-navigation.js";

export const settingsSections = {
  account: { label: "Profile", icon: UserIcon },
  devices: { label: "Devices", icon: MonitorIcon },
  projects: { label: "Projects", icon: FolderIcon },
  updates: { label: "Updates", icon: DownloadIcon },
  connections: { label: "Connectors", icon: PlugIcon },
  sync: { label: "Sync & startup", icon: RefreshCwIcon },
  general: { label: "General", icon: FolderIcon },
  members: { label: "Members", icon: UsersIcon },
  permissions: { label: "Permissions", icon: ShieldUserIcon },
  folder: { label: "Source folders", icon: FolderIcon },
  sharing: { label: "Sharing", icon: UsersIcon },
} as const;
export type SettingsSection = keyof typeof settingsSections;
const groups = {
  Account: ["account", "devices", "projects"],
  "This Mac": ["sync", "connections", "updates"],
  Project: ["general", "members", "permissions"],
} as const;
export function SettingsNavigation({
  projects,
  projectId,
  section,
  onSection,
}: {
  projects: Project[];
  projectId: string;
  section: SettingsSection;
  onSection: (section: SettingsSection) => void;
}) {
  const selected = projects.find((project) => project.id === projectId);
  const projectName = selected ? projectLabel(selected) : null;
  return (
    <aside className="settings-navigation">
      <nav aria-label="Settings sections">
        {Object.entries(groups).map(([group, sections]) => (
          <div
            className="settings-nav-group"
            role="group"
            aria-label={
              group === "Project" && projectName
                ? `Project settings for ${projectName}`
                : group
            }
            key={group}
          >
            <p
              className="settings-nav-label"
              title={
                group === "Project" ? (projectName ?? undefined) : undefined
              }
            >
              {group === "Project" && projectName
                ? `Project · ${projectName}`
                : group}
            </p>
            {sections.map((id) => {
              const { label, icon: Icon } = settingsSections[id];
              return (
                <button
                  key={id}
                  type="button"
                  aria-current={section === id ? "page" : undefined}
                  disabled={group === "Project" && !selected}
                  onClick={() => onSection(id)}
                >
                  <Icon size={16} aria-hidden="true" />
                  <span>{label}</span>
                </button>
              );
            })}
          </div>
        ))}
      </nav>
    </aside>
  );
}
