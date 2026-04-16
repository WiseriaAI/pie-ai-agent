import type { SkillDefinition } from "./types";

export const BUILT_IN_SKILLS: SkillDefinition[] = [
  {
    id: "extract_structured_data",
    name: "Extract Structured Data",
    description:
      "Extract structured information from the current page into JSON based on user-described fields.",
    toolSchema: {
      parameters: {
        type: "object",
        properties: {
          fields: {
            type: "array",
            items: { type: "string" },
          },
          format: {
            type: "string",
            enum: ["json", "csv"],
          },
        },
        required: ["fields"],
      },
    },
    promptTemplate:
      "Extract the following fields from the page: {{fields}}. Use the page snapshot and call extractData / done tools as needed. Output format: {{format}}.",
    enabled: true,
    builtIn: true,
  },
];
