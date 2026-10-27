export const nearBottom = (
  element: Pick<HTMLElement, "scrollHeight" | "scrollTop" | "clientHeight">,
) => element.scrollHeight - element.scrollTop - element.clientHeight < 100;
