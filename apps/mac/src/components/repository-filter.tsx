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
import { repositoryLabelSuffix } from "./project-sources.js";

type Repository = { id: string; name: string };
type RepositoryOptionData = { value: string; name: string; suffix: string };

function RepositoryName({ name, suffix }: RepositoryOptionData) {
  return (
    <span className="repository-select-name">
      <span>{name}</span>
      {suffix && <span>{suffix}</span>}
    </span>
  );
}

function RepositoryOption({
  option,
  index,
  registerItem,
}: {
  option: RepositoryOptionData;
  index: number;
  registerItem: ReturnType<typeof useFluidHover>["registerItem"];
}) {
  const ref = useRef<HTMLDivElement>(null);
  useRegisterFluidHoverItem(registerItem, index, ref);
  const label = option.name + option.suffix;
  return (
    <Select.Item
      ref={ref}
      value={option.value}
      textValue={label}
      title={label}
      className="repository-menu-option"
    >
      <Select.ItemText>
        <RepositoryName {...option} />
      </Select.ItemText>
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
      {options.map((option, index) => (
        <RepositoryOption
          key={option.value}
          option={option}
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
  repositories: Repository[];
  value: string;
  onChange: (value: string) => void;
}) {
  return (
    <RepositorySelect
      className="workspace-repository-filter"
      label="Filter by repository"
      repositories={repositories}
      includeAll
      value={value}
      placeholder="All repositories"
      onChange={onChange}
    />
  );
}

export function RepositorySelect({
  repositories,
  labelSources = repositories,
  includeAll = false,
  value,
  onChange,
  label,
  placeholder,
  className,
  size = "sm",
  align = "end",
  disabled,
}: {
  repositories: Repository[];
  labelSources?: Repository[];
  includeAll?: boolean;
  value: string;
  onChange: (value: string) => void;
  label: string;
  placeholder: string;
  className: string;
  size?: ControlSize;
  align?: "start" | "end";
  disabled?: boolean;
}) {
  const options = repositories.map((repository) => ({
    value: repository.id,
    name: repository.name,
    suffix: repositoryLabelSuffix(labelSources, repository),
  }));
  if (includeAll)
    options.unshift({ value: "all", name: "All repositories", suffix: "" });
  const selectedOption = options.find((option) => option.value === value);
  return (
    <Select.Root
      value={selectedOption?.value ?? ""}
      onValueChange={onChange}
      disabled={disabled}
    >
      <Select.Trigger asChild>
        <Button
          size={size}
          className={`repository-select-trigger ${className}`}
          aria-label={label}
          title={
            selectedOption
              ? selectedOption.name + selectedOption.suffix
              : placeholder
          }
        >
          <BookMarkedIcon size={16} aria-hidden="true" />
          <span>
            <Select.Value placeholder={placeholder}>
              {selectedOption && <RepositoryName {...selectedOption} />}
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
