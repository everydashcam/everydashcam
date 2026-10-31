import { parseSync } from "rolldown/utils";

function parseSource(fileName, source) {
    const { program, errors } = parseSync(fileName, source, {
        lang: "ts",
        sourceType: "module",
        preserveParens: false,
    });
    if (errors.length > 0) throw new Error(`cannot parse ${fileName}: ${errors[0].message}`);
    return program;
}

function unwrapType(node) {
    while (["TSAsExpression", "TSSatisfiesExpression", "TSTypeAssertion"].includes(node?.type)) {
        node = node.expression;
    }
    return node;
}

function exportedInitializer(program, name, fileName) {
    for (const statement of program.body) {
        if (statement.type !== "ExportNamedDeclaration") continue;
        const declaration = statement.declaration;
        if (declaration?.type !== "VariableDeclaration" || declaration.kind !== "const") continue;
        const binding = declaration.declarations.find((item) => item.id.type === "Identifier" && item.id.name === name);
        if (binding?.init) return unwrapType(binding.init);
    }
    throw new Error(`cannot find exported const ${name} in ${fileName}`);
}

/** The registry must remain an explicit ordered array of named value imports. */
export function parseRegistryBindings(fileName, source, registryName) {
    const program = parseSource(fileName, source);
    const imports = new Map();
    for (const statement of program.body) {
        if (statement.type !== "ImportDeclaration" || statement.importKind === "type") continue;
        for (const binding of statement.specifiers) {
            if (
                binding.type !== "ImportSpecifier" ||
                binding.importKind === "type" ||
                binding.imported.type !== "Identifier"
            ) {
                continue;
            }
            imports.set(binding.local.name, {
                specifier: statement.source.value,
                exportName: binding.imported.name,
            });
        }
    }

    const initializer = exportedInitializer(program, registryName, fileName);
    if (initializer.type !== "ArrayExpression" || initializer.elements.length === 0) {
        throw new Error(`${registryName} must be a non-empty explicit array in ${fileName}`);
    }
    // Do not silently omit a spread, factory call, hole, or inline primitive:
    // every runtime registry entry must participate in cache invalidation.
    return initializer.elements.map((entry) => {
        if (entry?.type !== "Identifier") throw new Error(`unsupported ${registryName} entry in ${fileName}`);
        const binding = imports.get(entry.name);
        if (!binding)
            throw new Error(`${registryName} entry ${entry.name} must be a named value import in ${fileName}`);
        return binding;
    });
}

/** Read only the primitive's own static id, never a nested object or comment. */
export function parsePrimitiveId(fileName, source, exportName) {
    const program = parseSource(fileName, source);
    const initializer = exportedInitializer(program, exportName, fileName);
    if (initializer.type !== "ObjectExpression") {
        throw new Error(`${exportName} must be an explicit object in ${fileName}`);
    }
    // A spread or computed key can overwrite id. Reject it instead of guessing.
    if (initializer.properties.some((property) => property.type !== "Property" || property.computed)) {
        throw new Error(`unsupported ${exportName} property in ${fileName}`);
    }
    const ids = initializer.properties.filter((property) => (property.key.name ?? property.key.value) === "id");
    if (ids.length !== 1 || ids[0].kind !== "init" || ids[0].method) {
        throw new Error(`cannot find a single static id for ${exportName} in ${fileName}`);
    }
    let value = unwrapType(ids[0].value);
    if (value.type === "Identifier") {
        const name = value.name;
        const declarations = program.body.flatMap((statement) => {
            const declaration = statement.type === "ExportNamedDeclaration" ? statement.declaration : statement;
            return declaration?.type === "VariableDeclaration" && declaration.kind === "const"
                ? declaration.declarations
                : [];
        });
        value = unwrapType(declarations.find((item) => item.id.type === "Identifier" && item.id.name === name)?.init);
    }
    if (value?.type === "Literal" && typeof value.value === "string" && value.value.length > 0) return value.value;
    throw new Error(`cannot find a static string id for ${exportName} in ${fileName}`);
}
