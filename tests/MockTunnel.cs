using System;
using System.Threading;
internal static class MockTunnel
{
    private static int Main(string[] args)
    {
        string url = "";
        for (int i = 0; i < args.Length - 1; i++) if (args[i] == "--url") url = args[i + 1];
        if (!String.IsNullOrEmpty(Environment.GetEnvironmentVariable("HTTP_PROXY")) || !String.IsNullOrEmpty(Environment.GetEnvironmentVariable("HTTPS_PROXY")) || !String.IsNullOrEmpty(Environment.GetEnvironmentVariable("ALL_PROXY"))) return 8;
        Thread.Sleep(Int32.Parse(Environment.GetEnvironmentVariable("ARGON_MOCK_DELAY") ?? "30"));
        if (Environment.GetEnvironmentVariable("ARGON_MOCK_ERROR") == "1")
        {
            Console.WriteLine("{\"lvl\":\"eror\",\"err\":\"ERR_NGROK_9010\"}"); return 7;
        }
        Console.WriteLine("{\"msg\":\"started tunnel\",\"url\":\"" + url + "\"}");
        if (Environment.GetEnvironmentVariable("ARGON_MOCK_RECOVER") == "1")
        {
            Thread.Sleep(100);
            Console.Error.WriteLine("{\"lvl\":\"eror\",\"msg\":\"heartbeat timeout\",\"obj\":\"session\"}");
            Thread.Sleep(250);
            Console.WriteLine("{\"lvl\":\"info\",\"msg\":\"client session established\"}");
            Thread.Sleep(250);
            Console.Error.WriteLine("{\"lvl\":\"eror\",\"msg\":\"proxy request failed\",\"obj\":\"proxy\"}");
        }
        Thread.Sleep(60000); return 0;
    }
}
