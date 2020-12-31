import * as Path from "path";
import * as FS from "fs";
import * as ts from "typescript";

import { Converter } from "./converter/index";
import { Renderer } from "./output/renderer";
import { Serializer } from "./serialization";
import { ProjectReflection } from "./models/index";
import {
    Logger,
    ConsoleLogger,
    CallbackLogger,
    PluginHost,
    normalizePath,
} from "./utils/index";
import { createMinimatch } from "./utils/paths";

import {
    AbstractComponent,
    ChildableComponent,
    Component,
    DUMMY_APPLICATION_OWNER,
} from "./utils/component";
import { Options, BindOption } from "./utils";
import { TypeDocOptions } from "./utils/options/declaration";
import { flatMap } from "./utils/array";

// eslint-disable-next-line @typescript-eslint/no-var-requires
const packageInfo = require("../../package.json") as {
    version: string;
    peerDependencies: { typescript: string };
};

const supportedVersionMajorMinor = packageInfo.peerDependencies.typescript
    .split("||")
    .map((version) => version.replace(/^\s*|\.x\s*$/g, ""));

// From: https://github.com/denoland/deno/blob/master/cli/tsc/99_main_compiler.js#L125
/** Diagnostics that are intentionally ignored when compiling TypeScript in
 * Deno, as they provide misleading or incorrect information. */
const IGNORED_DIAGNOSTICS = [
    // TS1208: All files must be modules when the '--isolatedModules' flag is
    // provided.  We can ignore because we guarantee that all files are
    // modules.
    1208,
    // TS1375: 'await' expressions are only allowed at the top level of a file
    // when that file is a module, but this file has no imports or exports.
    // Consider adding an empty 'export {}' to make this file a module.
    1375,
    // TS1103: 'for-await-of' statement is only allowed within an async function
    // or async generator.
    1103,
    // TS2306: File 'file:///Users/rld/src/deno/cli/tests/subdir/amd_like.js' is
    // not a module.
    2306,
    // TS2691: An import path cannot end with a '.ts' extension. Consider
    // importing 'bad-module' instead.
    2691,
    // TS2792: Cannot find module. Did you mean to set the 'moduleResolution'
    // option to 'node', or to add aliases to the 'paths' option?
    2792,
    // TS5009: Cannot find the common subdirectory path for the input files.
    5009,
    // TS5055: Cannot write file
    // 'http://localhost:4545/cli/tests/subdir/mt_application_x_javascript.j4.js'
    // because it would overwrite input file.
    5055,
    // TypeScript is overly opinionated that only CommonJS modules kinds can
    // support JSON imports.  Allegedly this was fixed in
    // Microsoft/TypeScript#26825 but that doesn't seem to be working here,
    // so we will ignore complaints about this compiler setting.
    5070,
    // TS7016: Could not find a declaration file for module '...'. '...'
    // implicitly has an 'any' type.  This is due to `allowJs` being off by
    // default but importing of a JavaScript module.
    7016,
];

/**
 * The default TypeDoc main application class.
 *
 * This class holds the two main components of TypeDoc, the [[Converter]] and
 * the [[Renderer]]. When running TypeDoc, first the [[Converter]] is invoked which
 * generates a [[ProjectReflection]] from the passed in source files. The
 * [[ProjectReflection]] is a hierarchical model representation of the TypeScript
 * project. Afterwards the model is passed to the [[Renderer]] which uses an instance
 * of [[BaseTheme]] to generate the final documentation.
 *
 * Both the [[Converter]] and the [[Renderer]] are subclasses of the [[AbstractComponent]]
 * and emit a series of events while processing the project. Subscribe to these Events
 * to control the application flow or alter the output.
 */
@Component({ name: "application", internal: true })
export class Application extends ChildableComponent<
    Application,
    AbstractComponent<Application>
> {
    /**
     * The converter used to create the declaration reflections.
     */
    converter: Converter;

    /**
     * The renderer used to generate the documentation output.
     */
    renderer: Renderer;

    /**
     * The serializer used to generate JSON output.
     */
    serializer: Serializer;

    /**
     * The logger that should be used to output messages.
     */
    logger: Logger;

    options: Options;

    plugins: PluginHost;

    @BindOption("logger")
    loggerType!: string | Function;

    @BindOption("exclude")
    exclude!: Array<string>;

    @BindOption("entryPoints")
    entryPoints!: string[];

    @BindOption("options")
    optionsFile!: string;

    @BindOption("tsconfig")
    project!: string;

    /**
     * The version number of TypeDoc.
     */
    static VERSION = packageInfo.version;

    /**
     * Create a new TypeDoc application instance.
     *
     * @param options An object containing the options that should be used.
     */
    constructor() {
        super(DUMMY_APPLICATION_OWNER);

        this.logger = new ConsoleLogger();
        this.options = new Options(this.logger);
        this.options.addDefaultDeclarations();
        this.serializer = new Serializer();
        this.converter = this.addComponent<Converter>("converter", Converter);
        this.renderer = this.addComponent<Renderer>("renderer", Renderer);
        this.plugins = this.addComponent("plugins", PluginHost);
    }

    /**
     * Initialize TypeDoc with the given options object.
     *
     * @param options  The desired options to set.
     */
    bootstrap(options: Partial<TypeDocOptions> = {}): void {
        for (const [key, val] of Object.entries(options)) {
            try {
                this.options.setValue(key as keyof TypeDocOptions, val);
            } catch {
                // Ignore errors, plugins haven't been loaded yet and may declare an option.
            }
        }
        this.options.read(new Logger());

        const logger = this.loggerType;
        if (typeof logger === "function") {
            this.logger = new CallbackLogger(<any>logger);
            this.options.setLogger(this.logger);
        } else if (logger === "none") {
            this.logger = new Logger();
            this.options.setLogger(this.logger);
        }
        this.logger.level = this.options.getValue("logLevel");

        this.plugins.load();

        this.options.reset();
        for (const [key, val] of Object.entries(options)) {
            try {
                this.options.setValue(key as keyof TypeDocOptions, val);
            } catch (error) {
                this.logger.error(error.message);
            }
        }
        this.options.read(this.logger);
    }

    /**
     * Return the application / root component instance.
     */
    get application(): Application {
        return this;
    }

    /**
     * Return the path to the TypeScript compiler.
     */
    public getTypeScriptPath(): string {
        return Path.dirname(require.resolve("typescript"));
    }

    public getTypeScriptVersion(): string {
        return ts.version;
    }

    /**
     * Run the converter for the given set of files and return the generated reflections.
     *
     * @param src  A list of source that should be compiled and converted.
     * @returns An instance of ProjectReflection on success, undefined otherwise.
     */
    public convert(): ProjectReflection | undefined {
        this.logger.verbose(
            "Using TypeScript %s from %s",
            this.getTypeScriptVersion(),
            this.getTypeScriptPath()
        );

        if (
            !supportedVersionMajorMinor.some(
                (version) => version == ts.versionMajorMinor
            )
        ) {
            this.logger.warn(
                `You are running with an unsupported TypeScript version! TypeDoc supports ${supportedVersionMajorMinor.join(
                    ", "
                )}`
            );
        }

        if (Object.keys(this.options.getCompilerOptions()).length === 0) {
            this.logger.warn(
                `No compiler options set. This likely means that TypeDoc did not find your tsconfig.json. Generated documentation will probably be empty.`
            );
        }

        // From: https://github.com/denoland/deno/blob/master/cli/tsc/99_main_compiler.js#L163
        const SNAPSHOT_COMPILE_OPTIONS = {
            esModuleInterop: true,
            jsx: ts.JsxEmit.React,
            module: ts.ModuleKind.ESNext,
            noEmit: true,
            strict: true,
            target: ts.ScriptTarget.ESNext,
        };

        const programs = [
            ts.createProgram({
                rootNames: this.application.options.getFileNames(),
                options: {
                    ...this.application.options.getCompilerOptions(),
                    ...SNAPSHOT_COMPILE_OPTIONS,
                },
                projectReferences: this.application.options.getProjectReferences(),
            }),
        ];

        // This might be a solution style tsconfig, in which case we need to add a program for each
        // reference so that the converter can look through each of these.
        if (programs[0].getRootFileNames().length === 0) {
            this.logger.verbose(
                "tsconfig appears to be a solution style tsconfig - creating programs for references"
            );
            const resolvedReferences = programs[0].getResolvedProjectReferences();
            for (const ref of resolvedReferences ?? []) {
                if (!ref) continue; // This indicates bad configuration... will be reported later.

                programs.push(
                    ts.createProgram({
                        options: {
                            ...ref.commandLine.options,
                            ...SNAPSHOT_COMPILE_OPTIONS,
                        },
                        rootNames: ref.commandLine.fileNames,
                        projectReferences: ref.commandLine.projectReferences,
                    })
                );
            }
        }

        this.logger.verbose(`Converting with ${programs.length} programs`);

        const emitFunc = (program: ts.Program) => {
            const result = ts.getPreEmitDiagnostics(program);
            return result.filter(
                ({ code }) => !IGNORED_DIAGNOSTICS.includes(code)
            );
        };
        const errors = flatMap(programs, emitFunc);
        if (errors.length) {
            this.logger.diagnostics(errors);
            return;
        }

        return this.converter.convert(
            this.expandInputFiles(this.entryPoints),
            programs
        );
    }

    /**
     * Render HTML for the given project
     */
    public async generateDocs(
        project: ProjectReflection,
        out: string
    ): Promise<void> {
        out = Path.resolve(out);
        await this.renderer.render(project, out);
        if (this.logger.hasErrors()) {
            this.logger.error(
                "Documentation could not be generated due to the errors above."
            );
        } else {
            this.logger.success("Documentation generated at %s", out);
        }
    }

    /**
     * Run the converter for the given set of files and write the reflections to a json file.
     *
     * @param out  The path and file name of the target file.
     * @returns TRUE if the json file could be written successfully, otherwise FALSE.
     */
    public async generateJson(
        project: ProjectReflection,
        out: string
    ): Promise<void> {
        out = Path.resolve(out);
        const eventData = {
            outputDirectory: Path.dirname(out),
            outputFile: Path.basename(out),
        };
        const ser = this.serializer.projectToObject(project, {
            begin: eventData,
            end: eventData,
        });
        await FS.promises.writeFile(out, JSON.stringify(ser, null, "\t"));
        this.logger.success("JSON written to %s", out);
    }

    /**
     * Expand a list of input files.
     *
     * Searches for directories in the input files list and replaces them with a
     * listing of all TypeScript files within them. One may use the ```--exclude``` option
     * to filter out files with a pattern.
     *
     * @param inputFiles  The list of files that should be expanded.
     * @returns  The list of input files with expanded directories.
     */
    public expandInputFiles(inputFiles: readonly string[]): string[] {
        const files: string[] = [];

        const exclude = createMinimatch(this.exclude);

        function isExcluded(fileName: string): boolean {
            return exclude.some((mm) => mm.match(fileName));
        }

        const supportedFileRegex =
            this.options.getCompilerOptions().allowJs ||
            this.options.getCompilerOptions().checkJs
                ? /\.[tj]sx?$/
                : /\.tsx?$/;
        function add(file: string, entryPoint: boolean) {
            let stats: FS.Stats;
            try {
                stats = FS.statSync(file);
            } catch {
                // No permission or a symbolic link, do not resolve.
                return;
            }
            const fileIsDir = stats.isDirectory();
            if (fileIsDir && !file.endsWith("/")) {
                file = `${file}/`;
            }

            if (!entryPoint && isExcluded(normalizePath(file))) {
                return;
            }

            if (fileIsDir) {
                FS.readdirSync(file).forEach((next) => {
                    add(Path.join(file, next), false);
                });
            } else if (supportedFileRegex.test(file)) {
                files.push(normalizePath(file));
            }
        }

        inputFiles.forEach((file) => {
            const resolved = Path.resolve(file);
            if (!FS.existsSync(resolved)) {
                this.logger.warn(
                    `Provided entry point ${file} does not exist and will not be included in the docs.`
                );
                return;
            }

            add(resolved, true);
        });

        return files;
    }

    /**
     * Print the version number.
     */
    toString() {
        return [
            "",
            `TypeDoc ${Application.VERSION}`,
            `Using TypeScript ${this.getTypeScriptVersion()} from ${this.getTypeScriptPath()}`,
            "",
        ].join("\n");
    }
}
