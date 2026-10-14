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
import org.eclipse.xtext.serializer.ISerializer;
import org.eclipse.emf.ecore.util.EcoreUtil;
import java.io.File;
import java.util.*;

// usage: Dump file.sctx [system] [processorIdSubstring|all|last]
public class Dump {
  public static void main(String[] a) throws Exception {
    Injector sctx = null;
    for (ILSSetup s : KielerServiceLoader.load(ILSSetup.class)) {
      Injector i = s.doLSSetup();
      if (s.getClass().getName().contains("SCTX")) sctx = i;
    }
    final Injector inj = sctx;
    XtextResourceSet rs = inj.getInstance(XtextResourceSet.class);
    Resource r = rs.getResource(URI.createFileURI(new File(a[0]).getAbsolutePath()), true);
    for (Resource.Diagnostic d : r.getErrors()) System.out.println("PARSE ERROR: " + d.getLine() + ":" + d.getColumn() + " " + d.getMessage());
    EObject model = r.getContents().get(0);
    String system = a.length > 1 ? a[1] : "de.cau.cs.kieler.sccharts.extended";
    final String which = a.length > 2 ? a[2] : "last";
    final ISerializer ser = inj.getInstance(ISerializer.class);
    CompilationContext ctx = Compile.createCompilationContext(system, model);
    ctx.addObserver((o, arg) -> {
      if (arg instanceof ProcessorFinished) {
        ProcessorFinished pf = (ProcessorFinished) arg;
        Processor<?,?> p = pf.getProcessorInstance();
        String id = p.getId();
        Environment env = p.getEnvironment();
        System.out.println("=== processor " + id + " errors=" + env.getErrors() + " warnings=" + env.getWarnings());
        if (which.equals("all") || (!which.equals("last") && id.contains(which))) {
          Object m = env.getProperty(Environment.MODEL);
          dump(ser, rs, m);
        }
      }
    });
    ctx.compile();
    if (which.equals("last")) dump(ser, rs, ctx.getResult().getModel());
    System.exit(0);
  }
  static void dump(ISerializer ser, ResourceSet rs, Object m) {
    try {
      if (m instanceof EObject) {
        EObject copy = EcoreUtil.copy((EObject) m);
        Resource out = rs.createResource(URI.createFileURI("/tmp/x" + System.nanoTime() + ".sctx"));
        out.getContents().add(copy);
        System.out.println(ser.serialize(copy));
      } else System.out.println(String.valueOf(m));
    } catch (Throwable t) { System.out.println("SERIALIZE FAILED: " + t); }
  }
}
