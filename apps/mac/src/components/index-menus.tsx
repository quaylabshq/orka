import {
  ArrowUpDownIcon,
  CheckIcon,
  ChevronRightIcon,
  ListFilterIcon,
  XIcon,
} from "lucide-react";
import React, { useRef } from "react";
import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import { Button } from "./button.js";
import { Icon } from "./icon.js";
import type { IconGlyph } from "./icons.js";
import "./item-menu.css";
import "./index-menus.css";

export interface FilterOption {
  value: string;
  label: string;
  icon?: IconGlyph;
  /** Options in one group sit together; a separator divides two groups. */
  group?: string;
}

export interface FilterCategory {
  id: string;
  label: string;
  icon: IconGlyph;
  options: FilterOption[];
  selected: string[];
}

const activeCount = (categories: FilterCategory[]) =>
  categories.reduce((count, category) => count + category.selected.length, 0);

/** One Filter button: categories, each opening its options beside it. */
export function FilterMenu({
  categories,
  onToggle,
  onClear,
}: {
  categories: FilterCategory[];
  onToggle: (category: string, value: string) => void;
  onClear: () => void;
}) {
  const count = activeCount(categories);
  return (
    <DropdownMenu.Root modal={false}>
      <DropdownMenu.Trigger asChild>
        <Button size="sm" variant="secondary" className="index-menu-trigger">
          <Icon icon={ListFilterIcon} size="sm" />
          Filter
          {count > 0 && (
            <span className="index-menu-count">
              {count}
              <span className="sr-only"> active</span>
            </span>
          )}
        </Button>
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content
          className="item-menu-content index-menu-content"
          align="start"
          sideOffset={6}
          collisionPadding={10}
        >
          {categories.map((category) => (
            <DropdownMenu.Sub key={category.id}>
              <DropdownMenu.SubTrigger className="item-menu-action">
                <category.icon
                  className="item-menu-icon"
                  size={16}
                  aria-hidden
                />
                <span className="item-menu-label">{category.label}</span>
                {category.selected.length > 0 && (
                  <span className="index-menu-count" aria-hidden="true">
                    {category.selected.length}
                  </span>
                )}
                <ChevronRightIcon size={14} aria-hidden="true" />
              </DropdownMenu.SubTrigger>
              <DropdownMenu.Portal>
                <DropdownMenu.SubContent
                  className="item-menu-content index-menu-options"
                  sideOffset={4}
                  alignOffset={-5}
                  collisionPadding={10}
                >
                  {category.options.map((option, index) => (
                    <React.Fragment key={option.value}>
                      {index > 0 &&
                        option.group !== category.options[index - 1].group && (
                          <DropdownMenu.Separator className="item-menu-separator" />
                        )}
                      <DropdownMenu.CheckboxItem
                        className="item-menu-action"
                        checked={category.selected.includes(option.value)}
                        onCheckedChange={() =>
                          onToggle(category.id, option.value)
                        }
                        // The menu stays open so several options can be ticked.
                        onSelect={(event) => event.preventDefault()}
                      >
                        {option.icon && (
                          <option.icon
                            className="item-menu-icon"
                            size={16}
                            aria-hidden
                          />
                        )}
                        <span className="item-menu-label">{option.label}</span>
                        <DropdownMenu.ItemIndicator>
                          <CheckIcon size={14} aria-hidden="true" />
                        </DropdownMenu.ItemIndicator>
                      </DropdownMenu.CheckboxItem>
                    </React.Fragment>
                  ))}
                </DropdownMenu.SubContent>
              </DropdownMenu.Portal>
            </DropdownMenu.Sub>
          ))}
          {count > 0 && (
            <>
              <DropdownMenu.Separator className="item-menu-separator" />
              <DropdownMenu.Item
                className="item-menu-action"
                onSelect={onClear}
              >
                <XIcon className="item-menu-icon" size={16} aria-hidden />
                <span className="item-menu-label">Clear all filters</span>
              </DropdownMenu.Item>
            </>
          )}
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
}

/** One chip per filtered category, each with its own remove button. */
export function ActiveFilters({
  categories,
  onRemove,
  onClear,
}: {
  categories: FilterCategory[];
  onRemove: (category: string) => void;
  onClear: () => void;
}) {
  const group = useRef<HTMLDivElement>(null);
  const active = categories.filter((category) => category.selected.length);
  if (!active.length) return null;
  /** The removed chip's button is gone; hand focus to the Filter button. */
  const refocus = () =>
    group.current?.parentElement
      ?.querySelector<HTMLElement>(".index-menu-trigger")
      ?.focus();
  return (
    <div
      ref={group}
      className="index-active-filters"
      role="group"
      aria-label="Active filters"
    >
      {active.map((category) => {
        const values = category.options
          .filter((option) => category.selected.includes(option.value))
          .map((option) => option.label)
          .join(", ");
        return (
          <span key={category.id} className="index-filter-chip">
            <category.icon size={12} aria-hidden="true" />
            <span className="index-filter-chip-name">{category.label}</span>
            <span className="index-filter-chip-value" title={values}>
              {values}
            </span>
            <button
              type="button"
              className="index-filter-chip-remove"
              aria-label={`Remove ${category.label} filter`}
              onClick={() => {
                refocus();
                onRemove(category.id);
              }}
            >
              <XIcon size={12} aria-hidden="true" />
            </button>
          </span>
        );
      })}
      {active.length > 1 && (
        <button
          type="button"
          className="index-filter-clear"
          onClick={() => {
            refocus();
            onClear();
          }}
        >
          Clear all
        </button>
      )}
    </div>
  );
}

export type SortDirection = "asc" | "desc";

export interface SortOption<T extends string> {
  value: T;
  label: string;
  icon: IconGlyph;
  /** Labels for ascending and descending, such as "A to Z" and "Z to A". */
  directions: [string, string];
}

/** Sort beside Filter: the current order on the button, direction in the menu. */
export function SortButton<T extends string>({
  value,
  direction,
  options,
  onChange,
}: {
  value: T;
  direction: SortDirection;
  options: SortOption<T>[];
  onChange: (sort: T, direction?: SortDirection) => void;
}) {
  const current = options.find((option) => option.value === value);
  return (
    <DropdownMenu.Root modal={false}>
      <DropdownMenu.Trigger asChild>
        <Button size="sm" variant="secondary" className="index-menu-trigger">
          <Icon icon={ArrowUpDownIcon} size="sm" />
          Sort
          <span className="index-menu-value">{current?.label}</span>
        </Button>
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content
          className="item-menu-content index-menu-content"
          align="start"
          sideOffset={6}
          collisionPadding={10}
        >
          <DropdownMenu.RadioGroup
            value={value}
            onValueChange={(next) => onChange(next as T)}
          >
            {options.map((option) => (
              <DropdownMenu.RadioItem
                key={option.value}
                value={option.value}
                className="item-menu-action"
              >
                <option.icon className="item-menu-icon" size={16} aria-hidden />
                <span className="item-menu-label">{option.label}</span>
                <DropdownMenu.ItemIndicator>
                  <CheckIcon size={14} aria-hidden="true" />
                </DropdownMenu.ItemIndicator>
              </DropdownMenu.RadioItem>
            ))}
          </DropdownMenu.RadioGroup>
          {current && (
            <>
              <DropdownMenu.Separator className="item-menu-separator" />
              <DropdownMenu.RadioGroup
                value={direction}
                onValueChange={(next) => onChange(value, next as SortDirection)}
              >
                {(["asc", "desc"] as const).map((item, index) => (
                  <DropdownMenu.RadioItem
                    key={item}
                    value={item}
                    className="item-menu-action"
                  >
                    <span className="item-menu-label">
                      {current.directions[index]}
                    </span>
                    <DropdownMenu.ItemIndicator>
                      <CheckIcon size={14} aria-hidden="true" />
                    </DropdownMenu.ItemIndicator>
                  </DropdownMenu.RadioItem>
                ))}
              </DropdownMenu.RadioGroup>
            </>
          )}
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
}
