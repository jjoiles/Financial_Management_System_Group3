import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

/**
 * Combines class names and resolves conflicting Tailwind utilities.
 * Falsy values are ignored, and later conflicting utilities take precedence.
 */
export function cn(...inputs: ClassValue[]): string {
  const merged = clsx(inputs);
  return twMerge(merged);
}
