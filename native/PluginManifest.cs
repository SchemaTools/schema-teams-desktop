// Read-only XML inspection. Never loads or executes assemblies referenced by a manifest.
using System;
using System.Collections.Generic;
using System.IO;
using System.Security.Cryptography;
using System.Text;
using System.Text.RegularExpressions;
using System.Web.Script.Serialization;
using System.Xml;

internal static class PluginManifest
{
    const int MaxBytes = 1024 * 1024;
    static readonly HashSet<string> Fields = new HashSet<string>(new string[] { "Name", "Text", "Assembly", "AddInId", "FullClassName", "VendorId", "VendorDescription", "AvailabilityClassName", "VisibilityMode", "Discipline", "AllowLoadIntoExistingSession" });
    static string Hex(byte[] bytes) { return BitConverter.ToString(bytes).Replace("-", "").ToLowerInvariant(); }
    static void Require(bool value) { if (!value) throw new XmlException(); }
    static string Get(Dictionary<string, string> fields, string name) { string value; Require(fields.TryGetValue(name, out value) && value.Length > 0); return value; }
    static XmlReaderSettings Settings() { return new XmlReaderSettings { DtdProcessing = DtdProcessing.Prohibit, XmlResolver = null, MaxCharactersInDocument = MaxBytes, MaxCharactersFromEntities = 1, CloseInput = false }; }
    static void CheckShape(FileStream file) {
        int nodes = 0;
        using (XmlReader reader = XmlReader.Create(file, Settings())) while (reader.Read()) Require(++nodes <= 8192 && reader.Depth <= 8 && reader.NodeType != XmlNodeType.ProcessingInstruction);
        file.Position = 0;
    }
    static List<Dictionary<string, string>> Parse(FileStream file)
    {
        XmlReaderSettings settings = Settings(); settings.IgnoreWhitespace = true; settings.IgnoreComments = true;
        List<Dictionary<string, string>> addIns = new List<Dictionary<string, string>>();
        using (XmlReader reader = XmlReader.Create(file, settings)) {
            reader.MoveToContent(); Require(reader.NodeType == XmlNodeType.Element && reader.Name == "RevitAddIns" && reader.NamespaceURI == "" && reader.AttributeCount == 0 && !reader.IsEmptyElement);
            reader.ReadStartElement("RevitAddIns");
            while (reader.MoveToContent() == XmlNodeType.Element) {
                Require(addIns.Count < 32 && reader.Name == "AddIn" && reader.NamespaceURI == "" && reader.AttributeCount == 1 && !reader.IsEmptyElement);
                string type = reader.GetAttribute("Type"); Require(type == "Application" || type == "Command");
                reader.ReadStartElement("AddIn"); Dictionary<string, string> fields = new Dictionary<string, string>();
                while (reader.MoveToContent() == XmlNodeType.Element) {
                    string name = reader.Name;
                    Require(reader.Depth == 2 && reader.NamespaceURI == "" && reader.AttributeCount == 0 && Fields.Contains(name) && !fields.ContainsKey(name));
                    string value = reader.ReadElementContentAsString().Trim(); Require(value.Length <= 512); fields.Add(name, value);
                }
                Require(reader.NodeType == XmlNodeType.EndElement && reader.Name == "AddIn"); reader.ReadEndElement();
                string id = Get(fields, "AddInId"), assembly = Get(fields, "Assembly"), fullClass = Get(fields, "FullClassName");
                // Autodesk: Name is required for ExternalApplication. Command Text
                // is optional; do not impose Application registration fields on it.
                if (type == "Application") Get(fields, "Name");
                Guid parsed; Require(Regex.IsMatch(id, "\\A[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}\\z") && Guid.TryParse(id, out parsed) && parsed != Guid.Empty);
                Require(Regex.IsMatch(fullClass, "\\A[A-Za-z_][A-Za-z0-9_.+`]{0,511}\\z"));
                addIns.Add(new Dictionary<string, string> { { "type", type }, { "assembly", assembly }, { "addInId", id.ToLowerInvariant() }, { "fullClassName", fullClass } });
            }
            Require(addIns.Count > 0 && reader.NodeType == XmlNodeType.EndElement && reader.Name == "RevitAddIns"); reader.ReadEndElement();
            Require(reader.MoveToContent() == XmlNodeType.None);
        }
        return addIns;
    }
    static int Main(string[] args)
    {
        Console.OutputEncoding = new UTF8Encoding(false);
        string hash = null, outputHash = null; long outputSize = 0; bool render = args.Length == 5 && args[0] == "render";
        string status = "unknown"; List<Dictionary<string, string>> addIns = new List<Dictionary<string, string>>();
        try {
            int first = render ? 1 : 0;
            if ((!render && args.Length != 2) || !Path.IsPathRooted(args[first]) || args[first].Length > 32760 || !Regex.IsMatch(args[first + 1], "\\A[0-9a-f]{64}\\z")) throw new XmlException();
            if ((File.GetAttributes(args[first]) & (FileAttributes.Directory | FileAttributes.ReparsePoint)) != 0) throw new XmlException();
            using (FileStream file = new FileStream(args[first], FileMode.Open, FileAccess.Read, FileShare.Read)) {
                Require(file.Length > 0 && file.Length <= MaxBytes);
                using (SHA256 sha = SHA256.Create()) hash = Hex(sha.ComputeHash(file));
                Require(hash == args[first + 1]); file.Position = 0; CheckShape(file); addIns = Parse(file);
                if (render) {
                    Require(Path.IsPathRooted(args[3]) && args[3].Length <= 32760 && args[4].Length <= 32768);
                    Dictionary<string, string> mapping = new JavaScriptSerializer().Deserialize<Dictionary<string, string>>(args[4]);
                    Require(mapping != null && mapping.Count == addIns.Count);
                    foreach (Dictionary<string, string> item in addIns) {
                        string target; Require(mapping.TryGetValue(item["addInId"], out target) && target != null && target.Length <= 1024 && Regex.IsMatch(target, "\\A[A-Za-z]:[\\\\/]") && target.EndsWith(".dll", StringComparison.OrdinalIgnoreCase) && !Regex.IsMatch(target.Substring(2), @"[\x00-\x1f:<>""|?*]") && Path.GetFullPath(target) == target);
                    }
                    file.Position = 0; XmlDocument document = new XmlDocument { XmlResolver = null, PreserveWhitespace = true };
                    using (XmlReader reader = XmlReader.Create(file, Settings())) document.Load(reader);
                    foreach (XmlNode node in document.SelectNodes("/RevitAddIns/AddIn")) {
                        string id = node.SelectSingleNode("AddInId").InnerText.Trim().ToLowerInvariant();
                        node.SelectSingleNode("Assembly").InnerText = mapping[id];
                    }
                    using (FileStream output = new FileStream(args[3], FileMode.CreateNew, FileAccess.ReadWrite, FileShare.None)) {
                        XmlWriterSettings writerSettings = new XmlWriterSettings { Encoding = new UTF8Encoding(false), Indent = false, CloseOutput = false, NewLineHandling = NewLineHandling.None };
                        using (XmlWriter writer = XmlWriter.Create(output, writerSettings)) document.Save(writer);
                        Require(output.Length > 0 && output.Length <= 2 * MaxBytes); output.Flush(true); outputSize = output.Length; output.Position = 0;
                        using (SHA256 sha = SHA256.Create()) outputHash = Hex(sha.ComputeHash(output));
                    }
                }
                file.Position = 0;
                using (SHA256 sha = SHA256.Create()) Require(hash == Hex(sha.ComputeHash(file)));
                status = "valid";
            }
        }
        catch (XmlException) { status = "invalid"; addIns.Clear(); }
        catch (Exception) { status = "unknown"; addIns.Clear(); }
        JavaScriptSerializer json = new JavaScriptSerializer();
        if (render) Console.WriteLine(json.Serialize(new { v = 1, status = status, sha256 = hash, addIns = addIns, outputSha256 = outputHash, outputSize = outputSize }));
        else Console.WriteLine(json.Serialize(new { v = 1, status = status, sha256 = hash, addIns = addIns }));
        return 0;
    }
}
