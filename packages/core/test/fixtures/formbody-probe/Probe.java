import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import java.io.BufferedReader;
import java.io.InputStreamReader;
import java.nio.charset.StandardCharsets;
import specmock.runtime.FormBody;

/** 테스트용 실행기: 표준 입력 한 줄마다 "<JSON>\t<걸린 ms>" 한 줄을 출력한다. 인자 coerce면 줄이 "<schema JSON>\t<form>". */
public class Probe {
  public static void main(String[] args) throws Exception {
    boolean coerce = args.length > 0 && args[0].equals("coerce");
    ObjectMapper m = new ObjectMapper();
    BufferedReader in = new BufferedReader(new InputStreamReader(System.in, StandardCharsets.UTF_8));
    StringBuilder out = new StringBuilder();
    String line;
    while ((line = in.readLine()) != null) {
      long t0 = System.nanoTime();
      JsonNode r;
      if (coerce) {
        int tab = line.indexOf('\t');
        r = FormBody.coerce(m.readTree(line.substring(0, tab)), FormBody.parse(line.substring(tab + 1)));
      } else {
        r = FormBody.parse(line);
      }
      long ms = (System.nanoTime() - t0) / 1_000_000;
      out.append(m.writeValueAsString(r)).append('\t').append(ms).append('\n');
    }
    System.out.print(out);
    System.out.flush();
  }
}
