import { BookMarkedIcon, CheckIcon, ChevronDownIcon } from "lucide-react";
import React, { useRef } from "react";
import * as Select from "@radix-ui/react-select";
import {
  useFluidHover,
  useRegisterFluidHoverItem,
} from "../hooks/use-fluid-hover.js";
import { Button } from "./button.js";
import { FluidHoverHighlight } from "./fluid-hover-highlight.js";
import type { ControlSize } from "./icon.js";
import { repositoryLabel } from "./project-sources.js";

type RepositoryOptionData = { value: string; label: string };

function RepositoryOption({
  value,
  label,
  index,
  registerItem,
}: {
  value: string;
  label: string;
  index: number;
  registerItem: ReturnType<typeof useFluidHover>["registerItem"];
}) {
  const ref = useRef<HTMLDivElement>(null);
  useRegisterFluidHoverItem(registerItem, index, ref);
  return (
    <Select.Item
      ref={ref}
      value={value}
      textValue={label}
      title={label}
      className="repository-menu-option"
    >
      <Select.ItemText>{label}</Select.ItemText>
      <span className="repository-menu-check">
        <Select.ItemIndicator>
          <CheckIcon size={16} aria-hidden="true" />
        </Select.ItemIndicator>
      </span>
    </Select.Item>
  );
}

function RepositoryOptions({ options }: { options: RepositoryOptionData[] }) {
  const ref = useRef<HTMLDivElement>(null);
  const hover = useFluidHover(ref, { axis: "y", gapClick: false });
  return (
    <Select.Viewport
      ref={ref}
      className="repository-menu-options"
      {...hover.handlers}
    >
      <FluidHoverHighlight hover={hover} className="project-menu-hover" />
      {options.map(({ value, label }, index) => (
        <RepositoryOption
          key={value}
          value={value}
          label={label}
          index={index}
          registerItem={hover.registerItem}
        />
      ))}
    </Select.Viewport>
  );
}

export function RepositoryFilter({
  repositories,
  value,
  onChange,
}: {
  repositories: { id: string; name: string }[];
  value: string;
  onChange: (value: string) => void;
}) {
  return (
    <RepositorySelect
      className="workspace-repository-filter"
      label="Filter by repository"
      options={[
        { value: "all", label: "All repositories" },
        ...repositories.map((repository) => ({
          value: repository.id,
          label:
            repositoryLabel(repositories, repository.id) ?? repository.name,
        })),
      ]}
      value={value}
      placeholder="All repositories"
      onChange={onChange}
    />
  );
}

export function RepositorySelect({
  options,
  value,
  onChange,
  label,
  placeholder,
  className,
  size = "sm",
  align = "end",
  disabled,
}: {
  options: RepositoryOptionData[];
  value: string;
  onChange: (value: string) => void;
  label: string;
  placeholder: string;
  className: string;
  size?: ControlSize;
  align?: "start" | "end";
  disabled?: boolean;
}) {
  const selectedLabel = options.find((option) => option.value === value)?.label;
  const displayLabel = selectedLabel ?? placeholder;
  return (
    <Select.Root
      value={selectedLabel === undefined ? "" : value}
      onValueChange={onChange}
      disabled={disabled}
    >
      <Select.Trigger asChild>
        <Button
          size={size}
          className={`repository-select-trigger ${className}`}
          aria-label={label}
          title={displayLabel}
        >
          <BookMarkedIcon size={16} aria-hidden="true" />
          <span className="repository-filter-label">
            <Select.Value placeholder={placeholder}>
              {selectedLabel}
            </Select.Value>
          </span>
          <Select.Icon asChild>
            <ChevronDownIcon size={14} aria-hidden="true" />
          </Select.Icon>
        </Button>
      </Select.Trigger>
      <Select.Portal>
        <Select.Content
          position="popper"
          align={align}
          sideOffset={6}
          collisionPadding={12}
          className="repository-menu"
          aria-label="Repositories"
        >
          <RepositoryOptions options={options} />
        </Select.Content>
      </Select.Portal>
    </Select.Root>
  );
}
