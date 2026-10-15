/**
 * A Radix Select inside a form keeps a hidden native select in step with its
 * value. When the value changes before the options have registered (a form
 * reset right after mount, with settings already loaded), the native select
 * cannot hold it and reports "" back through `onValueChange`, which would
 * clear the field. No item may have the value "", so "" is never the user's
 * choice: it is ignored.
 */
export const onSelect =
  (onChange: (value: string) => void) =>
  (value: string): void => {
    if (value !== "") onChange(value);
  };
