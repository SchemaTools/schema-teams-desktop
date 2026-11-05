using System;
using System.IO;
using System.Diagnostics;
using System.Collections.Generic;
// Read-only local checks. Never starts/stops Revit or changes filesystem/trust state.
// Процессы Revit считаются только в своём сеансе Windows: на RDS чужой Revit не задерживает обновление.
internal static class PluginSafety {
  static int Main(string[] args) {
    try {
      if(args.Length==1 && args[0]=="processes") {
        var ids=new List<int>();int session;
        using(var self=Process.GetCurrentProcess()) session=self.SessionId;
        foreach(var p in Process.GetProcessesByName("Revit")) { using(p) {if(p.SessionId!=session)continue;ids.Add(p.Id);if(ids.Count>4096)throw new InvalidOperationException();} }
        ids.Sort();Console.WriteLine("{\"v\":1,\"state\":\""+(ids.Count==0?"idle":"busy")+"\",\"pids\":["+String.Join(",",ids)+"]}");return 0;
      }
      if(args.Length==2 && args[0]=="path" && Path.IsPathRooted(args[1]) && args[1].Length<=32760 && args[1].IndexOf('\0')<0) {
        var current=Path.GetFullPath(args[1]);
        if(current.StartsWith(@"\\",StringComparison.Ordinal))throw new InvalidOperationException();
        while(!String.IsNullOrEmpty(current)) {
          try {if((File.GetAttributes(current)&FileAttributes.ReparsePoint)!=0){Console.WriteLine("{\"v\":1,\"state\":\"blocked\"}");return 0;}}
          catch(FileNotFoundException) {} catch(DirectoryNotFoundException) {}
          var parent=Path.GetDirectoryName(current);if(parent==current)break;current=parent;
        }
        Console.WriteLine("{\"v\":1,\"state\":\"safe\"}");return 0;
      }
    }catch{}
    Console.WriteLine("{\"v\":1,\"state\":\"unknown\"}");return 0;
  }
}
