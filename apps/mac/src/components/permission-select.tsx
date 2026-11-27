import { CheckIcon, ChevronDownIcon } from "lucide-react";
import React, { useId } from "react";
import * as Select from "@radix-ui/react-select";

export function PermissionSelect<T extends string>({
  label,
  value,
  valueLabel,
  options,
  disabled,
  required,
  onChange,
  placeholder,
  icon,
}: {
  label: string;
  placeholder?: string;
  icon?: React.ReactNode;
  value: T;
  valueLabel?: string;
  options: { value: T; label: string; disabled?: boolean }[];
  disabled?: boolean;
  required?: boolean;
  onChange: (value: T) => void;
}) {
  const id = useId();
  return (
    <Select.Root
      value={value}
      disabled={disabled}
      required={required}
      onValueChange={(value) => onChange(value as T)}
    >
      <Select.Trigger
        id={id}
        // Keep this button-backed combobox in WebKit’s form-control tab order.
        tabIndex={disabled ? undefined : 0}
        className="permission-select-trigger"
        aria-label={label}
        aria-required={required || undefined}
      >
        <Select.Value placeholder={placeholder}>{valueLabel}</Select.Value>
        <Select.Icon asChild>
          {icon ?? <ChevronDownIcon size={14} />}
        </Select.Icon>
      </Select.Trigger>
      <Select.Portal>
        <Select.Content
          className="project-menu permission-select-menu"
          position="popper"
          sideOffset={6}
          collisionPadding={12}
        >
          <Select.Viewport className="p-1">
            {options.map((option) => (
              <Select.Item
                key={option.value}
                value={option.value}
                disabled={option.disabled}
                className="project-menu-item"
                textValue={option.label}
              >
                <Select.ItemText>{option.label}</Select.ItemText>
                <Select.ItemIndicator>
                  <CheckIcon size={14} />
                </Select.ItemIndicator>
              </Select.Item>
            ))}
          </Select.Viewport>
        </Select.Content>
      </Select.Portal>
    </Select.Root>
  );
}
