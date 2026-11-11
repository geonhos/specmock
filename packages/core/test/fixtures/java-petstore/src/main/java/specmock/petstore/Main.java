package specmock.petstore;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ArrayNode;
import com.fasterxml.jackson.databind.node.ObjectNode;
import com.networknt.schema.JsonSchema;
import com.networknt.schema.JsonSchemaFactory;
import com.networknt.schema.SpecVersion;
import com.networknt.schema.ValidationMessage;
import io.javalin.Javalin;
import io.javalin.http.Context;
import io.javalin.http.HandlerType;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.regex.Pattern;
import specmock.runtime.FormBody;

/** specmock이 생성한 Petstore mock. fixtures/<기능 id>/<status>.json 을 요청마다 읽는다. */
public final class Main {
  private static final String SYSTEM = "petstore";
  private static final ObjectMapper JSON = new ObjectMapper();
  private static final JsonSchemaFactory SCHEMAS = JsonSchemaFactory.getInstance(SpecVersion.VersionFlag.V7);

  record Route(String id, String method, String path, int status, boolean hasBody, String schema) {}
  record Missing(String id, String method, String path) {}

  private static final List<Route> ROUTES = List.of(
      new Route("createPet", "POST", "/pets", 201, true, """
          {"type":"object","properties":{"params":{"type":"object","properties":{},"required":[]},"query":{"type":"object","properties":{},"required":[]},"body":{"type":"object","required":["name"],"properties":{"name":{"type":"string"},"tag":{"type":"string"}}}},"required":["body"]}
          """),
      new Route("getPet", "GET", "/pets/{petId}", 200, false, """
          {"type":"object","properties":{"params":{"type":"object","properties":{"petId":{"type":"integer"}},"required":["petId"]},"query":{"type":"object","properties":{},"required":[]},"body":{}},"required":[]}
          """));

  private static final List<Missing> NOT_MOCKED = List.of(
      new Missing("listPets", "GET", "/pets"),
      new Missing("deletePet", "DELETE", "/pets/{petId}"),
      new Missing("inventory.list", "GET", "/store/inventory"));

  public static void main(String[] args) throws Exception {
    int port = Integer.parseInt(System.getenv().getOrDefault("PORT", "4010"));
    Javalin app = Javalin.create(config -> config.showJavalinBanner = false);
    app.get("/__specmock/health", ctx -> {
      ObjectNode body = JSON.createObjectNode().put("ok", true).put("system", SYSTEM).put("features", ROUTES.size());
      send(ctx, 200, body);
    });
    for (Route r : ROUTES) {
      JsonSchema schema = SCHEMAS.getSchema(r.schema());
      JsonNode shape = JSON.readTree(r.schema());
      app.addHttpHandler(HandlerType.valueOf(r.method()), r.path(), ctx -> handle(ctx, r, schema, shape));
    }
    app.error(404, Main::notMocked);
    Runtime.getRuntime().addShutdownHook(new Thread(app::stop));
    app.start("127.0.0.1", port);
  }

  private static void handle(Context ctx, Route r, JsonSchema schema, JsonNode shape) throws Exception {
    ObjectNode data = JSON.createObjectNode();
    ObjectNode params = data.putObject("params");
    for (Map.Entry<String, String> e : ctx.pathParamMap().entrySet()) {
      params.set(e.getKey(), coerce(shape, "params", e.getKey(), e.getValue()));
    }
    ObjectNode query = data.putObject("query");
    for (Map.Entry<String, List<String>> e : ctx.queryParamMap().entrySet()) {
      if (!e.getValue().isEmpty()) query.set(e.getKey(), coerce(shape, "query", e.getKey(), e.getValue().get(0)));
    }
    if (r.hasBody() && !ctx.body().isBlank()) {
      if (FormBody.isForm(ctx.contentType())) {
        data.set("body", FormBody.coerce(shape.path("properties").path("body"), FormBody.parse(ctx.body())));
      } else {
        try { data.set("body", JSON.readTree(ctx.body())); } catch (Exception invalid) { /* 잘못된 JSON은 바디 없음으로 본다 */ }
      }
    }
    Set<ValidationMessage> errors = schema.validate(data);
    if (!errors.isEmpty()) {
      ObjectNode body = JSON.createObjectNode().put("error", "validation_failed");
      ArrayNode details = body.putArray("details");
      for (ValidationMessage m : errors) details.addObject().put("message", m.getMessage());
      send(ctx, 400, body);
      return;
    }
    if (r.status() == 204 || r.status() == 205) { ctx.status(r.status()); return; }
    ctx.status(r.status()).contentType("application/json")
        .result(Files.readString(Path.of("fixtures", r.id(), r.status() + ".json")));
  }

  /** path·query 값은 문자열로 온다. 스키마의 type에 맞춰 바꾼다(TS 템플릿의 ajv coerceTypes와 같은 효과). 바꿀 수 없으면 문자열로 두어 검증이 400을 내게 한다. */
  private static JsonNode coerce(JsonNode shape, String part, String key, String raw) {
    String pointer = "/properties/" + part + "/properties/" + key.replace("~", "~0").replace("/", "~1") + "/type";
    JsonNode t = shape.at(pointer);
    String type = "";
    if (t.isArray()) {
      for (JsonNode n : t) if (!n.asText("").equals("null")) { type = n.asText(""); break; }
    } else {
      type = t.asText("");
    }
    try {
      if (type.equals("integer")) return JSON.getNodeFactory().numberNode(Long.parseLong(raw));
      if (type.equals("number")) {
        double d = Double.parseDouble(raw);
        if (Double.isFinite(d)) return JSON.getNodeFactory().numberNode(d);
      }
    } catch (NumberFormatException keep) { /* 문자열로 두어 검증이 실패하게 한다 */ }
    if (type.equals("boolean") && (raw.equals("true") || raw.equals("false"))) return JSON.getNodeFactory().booleanNode(raw.equals("true"));
    return JSON.getNodeFactory().textNode(raw);
  }

  private static void notMocked(Context ctx) throws Exception {
    String method = ctx.method().name();
    String path = ctx.path();
    for (Missing m : NOT_MOCKED) {
      if (m.method().equals(method) && toRegex(m.path()).matcher(path).matches()) {
        ObjectNode body = JSON.createObjectNode().put("error", "not_mocked").put("feature", m.id())
            .put("hint", "specmock select " + SYSTEM + " --add " + m.id() + " && specmock generate " + SYSTEM);
        send(ctx, 501, body);
        return;
      }
    }
    send(ctx, 404, JSON.createObjectNode().put("error", "unknown_path").put("method", method).put("path", path));
  }

  private static Pattern toRegex(String template) {
    StringBuilder re = new StringBuilder("^");
    for (String part : template.split("(?=\\{)|(?<=\\})")) {
      re.append(part.startsWith("{") ? "[^/]+" : Pattern.quote(part));
    }
    return Pattern.compile(re.append("/?$").toString());
  }

  private static void send(Context ctx, int status, ObjectNode body) throws Exception {
    ctx.status(status).contentType("application/json").result(JSON.writeValueAsString(body));
  }
}
