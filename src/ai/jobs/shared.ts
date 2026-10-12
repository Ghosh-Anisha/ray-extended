import { z } from "zod";
import { CONFIDENCES } from "@/db/schema";

export const confidence = z.enum(CONFIDENCES);

const NUMBER = /\d+(?:[,.]\d+)*/g;
// The plain numbers written in a piece of text, commas removed.
export const numbersIn = (text: string) =>
  new Set((text.match(NUMBER) ?? []).map((n) => String(Number(n.replace(/,/g, "")))));
