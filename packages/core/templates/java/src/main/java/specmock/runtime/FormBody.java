package specmock.runtime;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.node.ArrayNode;
import com.fasterxml.jackson.databind.node.JsonNodeFactory;
import com.fasterxml.jackson.databind.node.ObjectNode;
import com.fasterxml.jackson.databind.node.TextNode;

import java.net.URLDecoder;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.List;
import java.util.Set;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/** application/x-www-form-urlencoded 본문을 대괄호 중첩 규칙으로 읽고, 스키마 타입에 맞춰 문자열을 변환한다.
 *  specmock이 생성 시 그대로 넣는 파일이다. TS 공용 파일 src/form.ts와 같은 규칙. */
public final class FormBody {
  public static final String CONTENT_TYPE = "application/x-www-form-urlencoded";
  private static final int MAX_DEPTH = 32;
  private static final int MAX_INDEX = 1000;
  private static final Set<String> BLOCKED = Set.of("__proto__", "constructor", "prototype");
  private static final Pattern KEY = Pattern.compile("^([^\\[\\]]+)((?:\\[[^\\[\\]]*\\])*)$");
  private static final Pattern SEG = Pattern.compile("\\[([^\\[\\]]*)\\]");
  private static final JsonNodeFactory F = JsonNodeFactory.instance;

  private FormBody() {}

  public static boolean isForm(String contentType) {
    if (contentType == null) return false;
    return contentType.split(";")[0].trim().toLowerCase().equals(CONTENT_TYPE);
  }

  /** 본문을 ObjectNode로. 값은 모두 TextNode. 비어 있으면 빈 ObjectNode. */
  public static ObjectNode parse(String text) {
    ObjectNode root = F.objectNode();
    if (text == null || text.isEmpty()) return root;
    for (String pair : text.split("&")) {
      if (pair.isEmpty()) continue;
      int eq = pair.indexOf('=');
      String k = decode(eq < 0 ? pair : pair.substring(0, eq));
      String v = eq < 0 ? "" : decode(pair.substring(eq + 1));
      List<String> segs = splitKey(k);
      if (segs == null || segs.size() > MAX_DEPTH) continue;
      if (segs.stream().anyMatch(BLOCKED::contains)) continue;
      if (segs.subList(1, segs.size()).stream().anyMatch(FormBody::overIndex)) continue;
      assign(root, segs, v);
    }
    return (ObjectNode) compact(root);
  }

  /** schema(JSON Schema)의 properties · items를 따라 integer/number/boolean 자리의 문자열을 변환한다. 변환 불가는 그대로. */
  public static JsonNode coerce(JsonNode schema, JsonNode value) {
    if (schema == null || value == null) return value;
    if (value.isTextual()) {
      String t = typeOf(schema);
      String s = value.asText();
      try {
        if ("integer".equals(t)) return F.numberNode(Long.parseLong(s));
        if ("number".equals(t)) {
          double d = Double.parseDouble(s);
          if (Double.isFinite(d)) return F.numberNode(d);
        }
      } catch (NumberFormatException ignored) { return value; }
      if ("boolean".equals(t)) {
        if ("true".equals(s)) return F.booleanNode(true);
        if ("false".equals(s)) return F.booleanNode(false);
      }
      return value;
    }
    if (value.isObject() && schema.has("properties")) {
      ObjectNode o = (ObjectNode) value;
      JsonNode props = schema.get("properties");
      List<String> names = new ArrayList<>();
      o.fieldNames().forEachRemaining(names::add);
      for (String n : names) if (props.has(n)) o.set(n, coerce(props.get(n), o.get(n)));
      return o;
    }
    if (value.isArray() && schema.has("items")) {
      ArrayNode a = (ArrayNode) value;
      for (int i = 0; i < a.size(); i++) a.set(i, coerce(schema.get("items"), a.get(i)));
      return a;
    }
    return value;
  }

  private static String typeOf(JsonNode schema) {
    JsonNode t = schema.get("type");
    if (t == null) return null;
    if (t.isTextual()) return t.asText();
    if (t.isArray()) { // ["object","integer"] 같은 경우: 스칼라 타입 하나를 고른다
      for (JsonNode x : t) {
        String s = x.asText();
        if (s.equals("integer") || s.equals("number") || s.equals("boolean")) return s;
      }
    }
    return null;
  }

  private static String decode(String s) {
    try {
      return URLDecoder.decode(s, StandardCharsets.UTF_8); // '+' → 공백 포함
    } catch (IllegalArgumentException bad) {
      return s; // 잘못된 % 표기는 그대로 둔다
    }
  }

  private static List<String> splitKey(String key) {
    Matcher m = KEY.matcher(key);
    if (!m.matches()) return null;
    List<String> segs = new ArrayList<>();
    segs.add(m.group(1));
    Matcher s = SEG.matcher(m.group(2));
    while (s.find()) segs.add(s.group(1));
    return segs;
  }

  private static boolean isDigits(String seg) { return !seg.isEmpty() && seg.chars().allMatch(c -> c >= '0' && c <= '9'); }

  private static boolean isIndex(String seg) { return seg.isEmpty() || isDigits(seg); }

  private static boolean overIndex(String seg) { return isDigits(seg) && (seg.length() > 4 || Integer.parseInt(seg) > MAX_INDEX); }

  private static void assign(JsonNode root, List<String> segs, String value) {
    JsonNode cur = root;
    for (int i = 0; i < segs.size(); i++) {
      String seg = segs.get(i);
      if (i == segs.size() - 1) { setLeaf(cur, seg, value); return; }
      cur = child(cur, seg, isIndex(segs.get(i + 1)));
      if (cur == null) return;
    }
  }

  private static void setLeaf(JsonNode cur, String seg, String value) {
    TextNode v = F.textNode(value);
    if (cur.isArray()) {
      ArrayNode a = (ArrayNode) cur;
      if (seg.isEmpty()) a.add(v);
      else if (isDigits(seg)) setAt(a, Integer.parseInt(seg), v);
      // 숫자가 아닌 키는 배열에 둘 수 없어 버린다
    } else if (cur.isObject()) {
      ObjectNode o = (ObjectNode) cur;
      JsonNode existing = o.get(seg);
      if (existing == null) o.set(seg, v);
      else if (existing.isArray()) ((ArrayNode) existing).add(v);
      else if (existing.isTextual()) { ArrayNode a = F.arrayNode(); a.add(existing); a.add(v); o.set(seg, a); }
      else o.set(seg, v);
    }
  }

  private static JsonNode child(JsonNode cur, String seg, boolean wantArray) {
    if (cur.isArray()) {
      ArrayNode a = (ArrayNode) cur;
      if (!seg.isEmpty() && !isDigits(seg)) return null;
      int idx = seg.isEmpty() ? a.size() : Integer.parseInt(seg);
      JsonNode n = idx < a.size() ? a.get(idx) : null;
      if (n == null || !n.isContainerNode()) { n = wantArray ? F.arrayNode() : F.objectNode(); setAt(a, idx, n); }
      return n;
    }
    if (cur.isObject()) {
      ObjectNode o = (ObjectNode) cur;
      JsonNode n = o.get(seg);
      if (n == null || !n.isContainerNode()) { n = wantArray ? F.arrayNode() : F.objectNode(); o.set(seg, n); }
      return n;
    }
    return null;
  }

  /** 인덱스 자리를 채우며 set. 건너뛴 자리는 NullNode로 두고 parse 끝의 compact가 지운다. */
  private static void setAt(ArrayNode a, int idx, JsonNode n) {
    while (a.size() <= idx) a.addNull();
    a.set(idx, n);
  }

  /** 배열의 건너뛴 빈 자리(NullNode)를 제거한다(TS compactArrays와 같다). 값은 TextNode뿐이라 null은 빈 자리다. */
  private static JsonNode compact(JsonNode v) {
    if (v.isArray()) {
      ArrayNode out = F.arrayNode();
      for (JsonNode x : v) if (!x.isNull()) out.add(compact(x));
      return out;
    }
    if (v.isObject()) {
      ObjectNode o = (ObjectNode) v;
      List<String> names = new ArrayList<>();
      o.fieldNames().forEachRemaining(names::add);
      for (String n : names) o.set(n, compact(o.get(n)));
    }
    return v;
  }
}
