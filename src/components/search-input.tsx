import { Search } from "lucide-react";
import type { ComponentProps } from "react";
import { InputGroup, InputGroupAddon, InputGroupInput } from "@/components/ui/input-group";

/**
 * A text box with a search icon. `className` sizes the box; `inputClassName`
 * styles the text (for example a monospace query).
 */
export function SearchInput({
  className,
  inputClassName,
  ...props
}: ComponentProps<"input"> & { inputClassName?: string }) {
  return (
    <InputGroup className={className}>
      <InputGroupInput className={inputClassName} {...props} />
      <InputGroupAddon>
        <Search />
      </InputGroupAddon>
    </InputGroup>
  );
}
