namespace PcMcp;

internal sealed record LaunchOptions(string? Home, bool Background, bool Show, bool Local,
    bool Headless, bool PrepareOnly, bool Autostart)
{
    internal bool ServiceOnly => Headless || PrepareOnly;

    internal static LaunchOptions Parse(string[] args)
    {
        var flags = new HashSet<string>(StringComparer.Ordinal);
        string? home = null;
        for (var index = 0; index < args.Length; index++)
        {
            var flag = args[index];
            if (!flags.Add(flag)) throw new ArgumentException($"Repeated option: {flag}");
            switch (flag)
            {
                case "--home":
                    if (++index >= args.Length || string.IsNullOrWhiteSpace(args[index]) || args[index].StartsWith("--", StringComparison.Ordinal))
                        throw new ArgumentException("--home requires a directory.");
                    home = args[index];
                    break;
                case "--background": case "--show": case "--local": case "--headless": case "--prepare-only": case "--autostart":
                    break;
                default:
                    throw new ArgumentException($"Unknown desktop option: {flag}");
            }
        }
        var options = new LaunchOptions(home, flags.Contains("--background"), flags.Contains("--show"),
            flags.Contains("--local"), flags.Contains("--headless"), flags.Contains("--prepare-only"), flags.Contains("--autostart"));
        if (options.Headless && options.PrepareOnly)
            throw new ArgumentException("--headless and --prepare-only cannot be combined.");
        if (options.Background && options.Show)
            throw new ArgumentException("--background and --show cannot be combined.");
        if (options.ServiceOnly && (options.Background || options.Show))
            throw new ArgumentException("A service command cannot use --background or --show.");
        return options;
    }
}
