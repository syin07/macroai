// Photo turns (PRD §5.6, FR-15). The image goes to one extraction call together with the user's
// caption, then is dropped: it is never stored, logged, or sent to the chat model (which only sees a
// "[photo attached]" marker).

const normalize = (text: string) => text.toLowerCase().replace(/\s+/g, " ").trim();

// The text for a photo's extraction call. The chat model's create_meal_proposal description is its own
// paraphrase; the user's caption ("fried, with ranch") goes in word for word so a detail the model
// dropped still reaches extraction. Whichever text already contains the other is used alone.
export function photoExtractionText(caption: string | undefined, description: string | undefined): string | undefined {
  const userText = caption?.trim() || undefined;
  const modelText = description?.trim() || undefined;
  if (!userText || !modelText) return userText ?? modelText;
  const [user, model] = [normalize(userText), normalize(modelText)];
  if (user.includes(model)) return userText;
  if (model.includes(user)) return modelText;
  return `${userText}\n${modelText}`;
}
