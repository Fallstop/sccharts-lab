import com.google.inject.Injector;
import de.cau.cs.kieler.core.ls.ILSSetup;
import de.cau.cs.kieler.core.services.KielerServiceLoader;
import de.cau.cs.kieler.kicool.compilation.*;
import de.cau.cs.kieler.kicool.compilation.observer.*;
import de.cau.cs.kieler.kicool.environments.Environment;
import org.eclipse.emf.ecore.*;
import org.eclipse.emf.ecore.resource.*;
import org.eclipse.emf.common.util.URI;
import org.eclipse.xtext.resource.XtextResourceSet;
import java.io.File;
import java.nio.file.*;
import java.util.*;

// KIELER's generated C code (the CodeContainer of de.cau.cs.kieler.scg.processors.codegen.c) for some charts, one JVM.
// usage (dumpc.sh): DumpC <system> <outdir> file1.sctx [file2.sctx ...]
// Writes <outdir>/<basename>/<file>.h|.c and log.txt (the processors that ran, their errors). System: e.g.
// de.cau.cs.kieler.sccharts.netlist ("Netlist-based Compilation (C)", the plain C chain, tests/codegen/kieler/) or
// de.cau.cs.kieler.sccharts.simulation.tts.netlist.c (the simulation chain; it also writes kieler-gen/ next to each
// chart, so copy the charts somewhere else first).
public class DumpC {
  public static void main(String[] a) throws Exception {
    Injector sctx = null;
    for (ILSSetup s : KielerServiceLoader.load(ILSSetup.class)) {
      Injector i = s.doLSSetup();
      if (s.getClass().getName().contains("SCTX")) sctx = i;
    }
    String system = a[0];
    Path out = Paths.get(a[1]);
    for (int k = 2; k < a.length; k++) {
      String f = a[k];
      String base = new File(f).getName().replaceAll("\\.sctx$", "");
      Path dir = out.resolve(base);
      Files.createDirectories(dir);
      StringBuilder log = new StringBuilder();
      try {
        XtextResourceSet rs = sctx.getInstance(XtextResourceSet.class);
        Resource r = rs.getResource(URI.createFileURI(new File(f).getAbsolutePath()), true);
        for (Resource.Diagnostic d : r.getErrors()) log.append("PARSE ERROR: " + d.getLine() + ":" + d.getColumn() + " " + d.getMessage() + "\n");
        EObject model = r.getContents().get(0);
        CompilationContext ctx = Compile.createCompilationContext(system, model);
        final List<CodeContainer> found = new ArrayList<>();
        ctx.addObserver((o, arg) -> {
          if (arg instanceof ProcessorFinished) {
            ProcessorFinished pf = (ProcessorFinished) arg;
            Processor<?,?> p = pf.getProcessorInstance();
            Environment env = p.getEnvironment();
            log.append("=== " + p.getId() + " errors=" + env.getErrors() + " warnings=" + env.getWarnings() + "\n");
            Object m = env.getProperty(Environment.MODEL);
            if (p.getId().equals("de.cau.cs.kieler.scg.processors.codegen.c") && m instanceof CodeContainer) found.add((CodeContainer) m);
          }
        });
        ctx.compile();
        for (CodeContainer cc : found) for (CodeFile cf : cc.getFiles()) {
          Files.write(dir.resolve(cf.getFileName()), cf.getCode().getBytes("UTF-8"));
        }
        if (found.isEmpty()) log.append("NO C CODE\n");
      } catch (Throwable t) { log.append("FAILED: " + t + "\n"); }
      Files.write(dir.resolve("log.txt"), log.toString().getBytes("UTF-8"));
      System.out.println(base);
    }
    System.exit(0);
  }
}
