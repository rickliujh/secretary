/** The parts of a React keyboard event that `isSubmitEnter` reads. */
type KeyEventLike = {
  key: string;
  shiftKey: boolean;
  nativeEvent: { isComposing: boolean };
};

/**
 * Enter that should send: not Shift+Enter (a new line), and not the Enter
 * that confirms an IME composition (Chinese, Japanese, Korean input).
 */
export const isSubmitEnter = (e: KeyEventLike) =>
  e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing;
