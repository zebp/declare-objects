#!/usr/bin/env node
import type * as _ts from "typescript";
import * as fs from "fs";
import path from "path";
import c from "chalk";
import { execa } from "execa";
import {
  experimental_patchConfig as patchConfig,
  unstable_readConfig as readConfig,
  type Unstable_Config as Config,
} from "wrangler";
import dedent from "dedent";
import { confirm, select } from "@clack/prompts";

import { assertNotCancelled, bail } from "./util.ts";

// We need to find the actual path to the TypeScript library, not just the package name,
// so for the POC we'll just get node to resolve it for us.
async function findTypeScriptPath(): Promise<string | undefined> {
  const script = dedent`
  try {
    console.log(require.resolve("typescript"));
  } catch (error) {
    console.error(error);
  }
  `;

  const result = await execa("node", ["-e", script]);
  const typescriptPath = result.stdout.trim();
  return typescriptPath.length > 0 ? typescriptPath : undefined;
}

// This function is responsible for creating a file with a default export that is a union of all
// the durable objects that are defined in the worker. Doing this logic via the compiler API is
// a bit of a pain, so we're going to off-load it to the compiler's internals and just grab the
// result from the type checker.
function durableObjectResolverFile(
  ts: typeof _ts,
  workerMain: string
): _ts.SourceFile {
  return ts.createSourceFile(
    "/declare/resolver.ts",
    dedent`
    import type { DurableObject as DurableObjectEntrypoint } from 'cloudflare:workers';
    import type * as worker from "${path.resolve(workerMain)}";

    type Worker = typeof worker;

    type IsDurableObject<T> = T extends { new (...args: any[]): DurableObject }
			? true
			: T extends { new (...args: any[]): DurableObjectEntrypoint }
				? true
				: IsPrototypeDurableObject<T>;

		type IsPrototypeDurableObject<T> = T extends { prototype: infer Proto }
			? Proto extends DurableObjectEntrypoint
				? true
				: Proto extends DurableObject
					? true
					: false
			: false;

    type FindDos<T extends keyof Worker> = {
      [K in T]: IsDurableObject<Worker[K]> extends true ? K : never;
    }[T];

    type A = FindDos<keyof Worker>;

    export default null as any as FindDos<keyof Worker>;
    `,
    {
      languageVersion: ts.ScriptTarget.ESNext,
    }
  );
}

async function createTypescript(wranglerConfig: Config, script?: string) {
  const tsPath = await findTypeScriptPath();
  if (!tsPath) {
    throw new Error("TypeScript must be installed to use this command");
  }

  const ts: typeof _ts = await import(tsPath);

  const tsConfig = ts.readConfigFile("./tsconfig.json", (typescriptPath) =>
    fs.readFileSync(typescriptPath, "utf-8")
  );

  const main =
    script ?? wranglerConfig.main ?? bail("Worker main was not found");

  const resolverFile = durableObjectResolverFile(ts, main);

  const parsed = ts.parseJsonConfigFileContent(tsConfig.config, ts.sys, "./");
  const host = ts.createCompilerHost(parsed.options);
  const foo = ts.resolveModuleName(
    "@cloudflare/workers-types",
    main,
    parsed.options,
    host
  );
  const program = ts.createProgram({
    rootNames: ["/declare/resolver.ts"],
    options: {
      ...parsed.options,
      types: foo.resolvedModule?.resolvedFileName
        ? [...(parsed.options.types ?? []), foo.resolvedModule.resolvedFileName]
        : parsed.options.types,
    },
    host: {
      ...host,
      getSourceFile(
        fileName,
        languageVersionOrOptions,
        onError,
        shouldCreateNewSourceFile
      ) {
        if (fileName === "/declare/resolver.ts") {
          return resolverFile;
        }

        return host.getSourceFile(
          fileName,
          languageVersionOrOptions,
          onError,
          shouldCreateNewSourceFile
        );
      },
    },
  });

  return program;
}

const namingStyleDisplayNames = {
  camel: "camelCase",
  pascal: "PascalCase",
  upper_snake: "UPPER_SNAKE_CASE",
  lower_snake: "lower_snake_case",
} as const;

async function getNamingStyleFromOtherBindings(
  config: Config
): Promise<"camel" | "pascal" | "upper_snake" | "lower_snake"> {
  const keys = [
    "kv_namespaces",
    "services",
    "d1_databases",
    "vectorize",
  ] as const;

  for (const key of keys) {
    const value = config[key];

    if (!value) {
      continue;
    }

    const maybeStyle = getNamingStyleFromNamedItems(value);
    if (maybeStyle) {
      console.info(
        `Detected bindings with ${c.dim(
          namingStyleDisplayNames[maybeStyle]
        )} naming style, using that for Durable Objects`
      );
      return maybeStyle;
    }
  }

  const style = await select({
    message: "What naming style should be used for the Durable Objects?",
    options: [
      { label: "UPPER_SNAKE_CASE", value: "upper_snake" },
      { label: "camelCase", value: "camel" },
      { label: "lower_snake_case", value: "lower_snake" },
      { label: "PascalCase", value: "pascal" },
    ],
  });
  assertNotCancelled(style);
  return style as "camel" | "pascal" | "upper_snake" | "lower_snake";
}

function getNamingStyleFromNamedItems(
  items: { binding: string }[]
): "camel" | "pascal" | "upper_snake" | "lower_snake" | undefined {
  if (items.length === 0) {
    return undefined;
  }

  // Check if all items match a specific naming convention
  const allCamelCase = items.every((item) =>
    /^[a-z][a-zA-Z0-9]*$/.test(item.binding)
  );
  if (allCamelCase) {
    return "camel";
  }

  const allPascalCase = items.every((item) =>
    /^[A-Z][a-zA-Z0-9]*$/.test(item.binding)
  );
  if (allPascalCase) {
    return "pascal";
  }

  const allUpperSnakeCase = items.every((item) =>
    /^[A-Z][A-Z0-9]*(_[A-Z0-9]+)*$/.test(item.binding)
  );
  if (allUpperSnakeCase) {
    return "upper_snake";
  }

  const allLowerSnakeCase = items.every((item) =>
    /^[a-z][a-z0-9]*(_[a-z0-9]+)*$/.test(item.binding)
  );
  if (allLowerSnakeCase) {
    return "lower_snake";
  }

  return undefined;
}

function styleNames(
  nameAsPascalCase: string,
  style: "camel" | "pascal" | "upper_snake" | "lower_snake"
): string {
  // Already in PascalCase
  if (style === "pascal") {
    return nameAsPascalCase;
  }

  // Split the PascalCase name into parts
  const parts = nameAsPascalCase
    .replace(/([A-Z])/g, " $1")
    .trim()
    .split(" ");

  if (style === "camel") {
    // Convert to camelCase: first part lowercase, rest PascalCase
    return parts[0]!.toLowerCase() + parts.slice(1).join("");
  } else if (style === "upper_snake") {
    // Convert to UPPER_SNAKE_CASE
    return parts.map((part) => part.toUpperCase()).join("_");
  } else if (style === "lower_snake") {
    // Convert to lower_snake_case
    return parts.map((part) => part.toLowerCase()).join("_");
  }

  // Default fallback (shouldn't happen due to type constraints)
  return nameAsPascalCase;
}

const config = readConfig({});
const existingDurableObjects = config.durable_objects.bindings.map(
  (binding) => binding.name
);

const program = await createTypescript(config);
const checker = program.getTypeChecker();

const resolverFile =
  program.getSourceFile("/declare/resolver.ts") ??
  bail("Resolver file was not found");
const sourceFileSymbol =
  checker.getSymbolAtLocation(resolverFile) ??
  bail("resolver file symbol was not found");

const exports = checker.getExportsOfModule(sourceFileSymbol);
const defaultExport =
  exports.find((e) => e.name === "default") ??
  bail("Default export was not found");
const defaultType = checker.getTypeOfSymbol(defaultExport);

let itemsExtendingDurableObject = undefined;

if (defaultType.isUnion()) {
  itemsExtendingDurableObject = defaultType.types.map((it) =>
    checker.typeToString(it).replaceAll('"', "")
  );
} else if (defaultType.isStringLiteral()) {
  itemsExtendingDurableObject = [
    checker.typeToString(defaultType).replaceAll('"', ""),
  ];
}

itemsExtendingDurableObject = itemsExtendingDurableObject?.filter(
  (name) => !existingDurableObjects.includes(name)
);

if (!itemsExtendingDurableObject) {
  throw new Error("No Durable Objects found in your Worker");
}

console.warn(
  `Found ${itemsExtendingDurableObject.length} Durable Objects that aren't present in your wrangler config`
);

for (const item of itemsExtendingDurableObject) {
  console.log(` - ${item}`);
}

console.log("");

const namingStyle = await getNamingStyleFromOtherBindings(config);

const confirmed = await confirm({
  message: `Are you sure you want to declare ${itemsExtendingDurableObject.length} Durable Objects in your config and add a migration for them?`,
});
assertNotCancelled(confirmed);

if (!confirmed) {
  process.exit(0);
}

patchConfig(config.configPath ?? bail("No config path found"), {
  durable_objects: {
    bindings: itemsExtendingDurableObject.map((it) => ({
      name: styleNames(it, namingStyle),
      class_name: it,
    })),
  },
  migrations: [
    {
      tag: `${new Date().toISOString()}-${itemsExtendingDurableObject.join(
        "-"
      )}`,
      new_sqlite_classes: itemsExtendingDurableObject,
    },
  ],
});
